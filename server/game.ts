/**
 * The issuer half of "Button".
 *
 * This file is the whole backend. There is no database, no balances table, no
 * inventory table, and no ledger of who owns what — those are questions the
 * chain answers, and asking it is `balanceOf`. What is left is the part a game
 * server is actually for: deciding what a press is worth and what things cost.
 *
 * It holds the game's seed, which is why it cannot run in a browser (SPEC §6.3).
 */

import { Kei, type ClaimBundle, type IssuerToken, type Item } from 'kei-transaction'
import type { KeiNode } from 'kei-transaction'

import {
  COIN,
  COINS_PER_KEI,
  MINIMUM_TOP_UP,
  UPGRADES,
  payoutFor,
  upgradeBySku,
  type CataloguePayload,
} from '../shared/catalogue.js'

export interface GameOptions {
  seed: string
  node: KeiNode | string
  network?: 'mock' | 'testnet' | 'mainnet'
  /** SPEC §8: the demo must be enjoyable with payments switched off. */
  exchange?: boolean
  /** How long banked presses wait to be batched with everybody else's. */
  flushMs?: number
  /** Presses a second above which a bank is not a human hand. */
  pressRateCap?: number
}

export interface Game {
  address: string
  catalogue(): CataloguePayload
  /** Pay for presses. Returns the proof the player claims with (SPEC §5.5). */
  bank(address: string, presses: number): Promise<ClaimBundle>
  /** Defeat a world mob once; its coin drop is a rooted claim, not server state. */
  loot(address: string, mob: string): Promise<ClaimBundle>
  /** Take an order, so an anonymous coin transfer can be matched to a purchase. */
  order(address: string, sku: string): Promise<{ to: string; price: number; asset: string }>
  close(): void
}

/** Fast for a finger, slow for a script. */
const DEFAULT_PRESS_RATE_CAP = 25
/** An order nobody paid for is forgotten after this long. */
const ORDER_TTL_MS = 120_000

export async function startGame(options: GameOptions): Promise<Game> {
  const kei = await Kei.server({
    seed: options.seed,
    node: options.node,
    ...(options.network === undefined ? {} : { network: options.network }),
  })

  // Issuance burns 1,000 Kei per asset (SPEC §5.6.5), and this game issues one
  // currency and five upgrades. On a real network somebody funds this address
  // once; on a mock the faucet does.
  const needed = (UPGRADES.length + 1) * 1_000 + 100
  if ((await kei.balance()) < needed) await kei.faucet(needed)

  const coins = await kei.token.issue({
    name: COIN.name,
    symbol: COIN.symbol,
    decimals: COIN.decimals,
    maxSupply: COIN.maxSupply,
    // Open, because a closed economy is a promise this game does not want to
    // make: players can trade coins with each other, and eventually will.
    transfer: 'open',
    swap: 'one-way',
    rate: COINS_PER_KEI,
  })

  const items = new Map<string, Item>()
  for (const upgrade of UPGRADES) {
    items.set(
      upgrade.sku,
      await kei.items.create({
        name: upgrade.name,
        description: upgrade.description,
        supply: upgrade.supply,
        transfer: 'open',
      }),
    )
  }

  const exchange = options.exchange !== false
  const stopTopUps = exchange
    ? kei.acceptTopUps({ token: coins, rate: COINS_PER_KEI, minimum: MINIMUM_TOP_UP })
    : undefined

  const shop = openShop(kei, coins, items)
  const drops = new DropBatch(coins, options.flushMs ?? 1_500)
  const lastBank = new Map<string, number>()
  const rateCap = options.pressRateCap ?? DEFAULT_PRESS_RATE_CAP
  const lootClaims = new Map<string, Promise<ClaimBundle>>()

  return {
    address: kei.address,

    catalogue() {
      return {
        issuer: kei.address,
        network: kei.network,
        coin: { asset: coins.id, symbol: coins.symbol, decimals: coins.decimals },
        exchange: { open: exchange, coinsPerKei: COINS_PER_KEI, minimum: MINIMUM_TOP_UP },
        upgrades: UPGRADES.map((upgrade) => ({ ...upgrade, asset: items.get(upgrade.sku)!.id })),
      }
    },

    async bank(address, presses) {
      const now = Date.now()
      const since = now - (lastBank.get(address) ?? now - 1_000)
      lastBank.set(address, now)

      // The client counts the presses, because in single-player nothing else
      // sees them. That is a real trust hole and this is not a fix for it — it
      // is a ceiling, so the hole is worth a few coins rather than the supply.
      // M8 puts Colyseus in the room and the presses become observed.
      const allowed = Math.max(1, Math.ceil((since / 1_000) * rateCap) + rateCap)
      const counted = Math.min(Math.floor(presses), allowed)
      if (!(counted > 0)) throw new GameError('That was zero presses.')

      const { perPress } = payoutFor(await ownedBy(kei, address, items))
      return drops.add(address, counted * perPress)
    },

    loot(address, mob) {
      if (!/^slime-[1-3]$/.test(mob)) throw new GameError('That mob does not exist.')
      const key = `${address}:${mob}`
      const existing = lootClaims.get(key)
      if (existing) return existing
      // Store the promise before waiting so double clicks cannot publish two leaves.
      const claim = drops.add(address, 25).catch((error) => {
        lootClaims.delete(key)
        throw error
      })
      lootClaims.set(key, claim)
      return claim
    },

    order(address, sku) {
      return shop.order(address, sku)
    },

    close() {
      drops.close()
      shop.close()
      stopTopUps?.()
      kei.close()
    },
  }
}

export class GameError extends Error {}

// --------------------------------------------------------------------- drops

/**
 * Presses banked by every player in the same window become **one** issuer block.
 *
 * This is the whole point of §5.5. Minting per player would make this account's
 * chain a global write lock, and the queue behind it would be the game. Instead
 * the issuer publishes one root, and each player writes their own claim from
 * their own chain, in parallel, with no contention between them.
 *
 * With one player it is a batch of one, and the code is identical — which is the
 * useful property, because nothing has to be rewritten when there are a thousand.
 */
class DropBatch {
  private pending = new Map<string, number>()
  private waiting = new Map<string, Array<(bundle: ClaimBundle) => void>>()
  private failures = new Map<string, Array<(error: unknown) => void>>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly coins: IssuerToken,
    private readonly flushMs: number,
  ) {}

  add(address: string, amount: number): Promise<ClaimBundle> {
    // Merged per address: a root commits to at most one entitlement per account,
    // so two banks inside one window are one leaf, not two.
    this.pending.set(address, (this.pending.get(address) ?? 0) + amount)

    return new Promise<ClaimBundle>((resolve, reject) => {
      push(this.waiting, address, resolve)
      push(this.failures, address, reject)
      this.timer ??= setTimeout(() => void this.flush(), this.flushMs)
    })
  }

  private async flush(): Promise<void> {
    this.timer = undefined
    const batch = [...this.pending]
    const waiting = this.waiting
    const failures = this.failures
    this.pending = new Map()
    this.waiting = new Map()
    this.failures = new Map()
    if (batch.length === 0) return

    try {
      const drop = await this.coins.commit(batch.map(([to, amount]) => ({ to, amount })))
      for (const [address] of batch) {
        const bundle = drop.proofFor(address)
        for (const resolve of waiting.get(address) ?? []) resolve(bundle)
      }
    } catch (error) {
      for (const [address] of batch) {
        for (const reject of failures.get(address) ?? []) reject(error)
      }
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

// ---------------------------------------------------------------------- shop

interface Order {
  sku: string
  price: number
  at: number
}

/**
 * Buying an upgrade is a coin transfer the player signs, and a mint the issuer
 * signs in response — the same two-signature shape as a Kei purchase, because
 * the game cannot sign for a player's wallet and never will (SPEC §6.3).
 *
 * A transfer carries no memo (decisions-m0 §4), so the intent is recorded here
 * first and matched to the arrival. The order is not the purchase: nothing is
 * delivered until the chain says the coins landed.
 */
function openShop(
  kei: Kei,
  coins: IssuerToken,
  items: ReadonlyMap<string, Item>,
): { order(address: string, sku: string): Promise<{ to: string; price: number; asset: string }>; close(): void } {
  const orders = new Map<string, Order>()

  const stop = kei.on('asset-received', (arrival) => {
    if (arrival.asset !== coins.id) return
    const order = orders.get(arrival.from)
    if (!order || arrival.amount < order.price) return
    orders.delete(arrival.from)

    void (async () => {
      const item = items.get(order.sku)
      if (!item) return
      await kei.items.mint(item.id, arrival.from)
      // The shop is a sink: coins spent here stop existing, which frees the
      // headroom they took under the cap (SPEC §5.6.6).
      await coins.burn(order.price)
    })()
  })

  return {
    async order(address, sku) {
      const upgrade = upgradeBySku(sku)
      const item = items.get(sku)
      if (!upgrade || !item) throw new GameError(`The shop does not sell "${sku}".`)

      const held = await coins.balanceOf(address)
      if (held < upgrade.price) {
        throw new GameError(
          `${upgrade.name} costs ${upgrade.price} coins and you have ${held}. Press the button a few more times.`,
        )
      }

      for (const [who, order] of orders) {
        if (Date.now() - order.at > ORDER_TTL_MS) orders.delete(who)
      }
      orders.set(address, { sku, price: upgrade.price, at: Date.now() })
      return { to: kei.address, price: upgrade.price, asset: coins.id }
    },
    close: stop,
  }
}

/** What this player owns, by sku — read from the chain, because that is where it is. */
async function ownedBy(kei: Kei, address: string, items: ReadonlyMap<string, Item>): Promise<Record<string, number>> {
  const holdings = await kei.client.node.holdings(address)
  const counts: Record<string, number> = {}
  for (const [sku, item] of items) {
    const holding = holdings.find((entry) => entry.asset === item.id)
    if (holding) counts[sku] = Number(holding.balance)
  }
  return counts
}
