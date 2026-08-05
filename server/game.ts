/**
 * The issuer half of "Button".
 *
 * This file is the whole backend. There is no database, no balances table, no
 * inventory table, and no ledger of who owns what — those are questions the
 * chain answers, and asking it is `balanceOf`. What is left is the part a game
 * server is actually for: deciding what a press is worth and what things cost.
 *
 * It holds the game's seed, which is why it cannot run in a browser (SPEC §6.3).
 *
 * Every rewarding method here takes a **session id**, never an address and never
 * a count. `server/sessions.ts` is what turns one into the other, and it is the
 * only thing in this repository that decides who a caller is or what this
 * server watched them do.
 */

import { Kei, type ClaimBundle, type IssuerToken, type Item } from 'kei-transaction'
import type { KeiNode } from 'kei-transaction'

import type { OwnershipChallengeMessage } from '../shared/ownership.js'
import {
  COIN,
  COINS_PER_KEI,
  MINIMUM_TOP_UP,
  UPGRADES,
  payoutFor,
  upgradeBySku,
  type CataloguePayload,
} from '../shared/catalogue.js'
import { GameError } from './errors.js'
import {
  DEFAULT_OBSERVATION_RATE,
  createSessions,
  type HitReceipt,
  type PressReceipt,
  type Session,
} from './sessions.js'

export interface GameOptions {
  seed: string
  node: KeiNode | string
  network?: 'mock' | 'testnet' | 'mainnet'
  /** SPEC §8: the demo must be enjoyable with payments switched off. */
  exchange?: boolean
  /** How long banked presses wait to be batched with everybody else's. */
  flushMs?: number
  /** Presses a second above which this server stops watching (SPEC §8, and #10). */
  pressRateCap?: number
  /** The largest burst a rested address may spend. Defaults to two seconds' worth. */
  pressBurst?: number
  /** Names this running instance inside the challenge. Defaults to the issuer address. */
  room?: string
  /** Test seam for the observation ceiling's clock. */
  now?: () => number
}

export interface Game {
  address: string
  /** Which instance this is. Signed into every challenge, so proofs do not travel. */
  room: string
  catalogue(): CataloguePayload
  /** What a wallet signs to bind a session to its address. One use, and it expires. */
  challenge(address: string, origin: string): OwnershipChallengeMessage
  /** Redeem a signed challenge. Everything below needs the id this returns. */
  authenticate(proof: unknown, origin: string): Promise<Session>
  /** One press, counted here because this request arrived — never a caller's figure. */
  press(session: unknown, origin: string): PressReceipt
  /** One hit on a mob. This server decides when it died, and names the event. */
  hit(session: unknown, origin: string, mob: unknown): HitReceipt
  /** Pay for the presses this server observed. Returns the proof to claim with (§5.5). */
  bank(session: unknown, origin: string): Promise<ClaimBundle>
  /** Collect a kill this server recorded, by the event id the kill returned. */
  loot(session: unknown, origin: string, event: unknown): Promise<ClaimBundle>
  /** Take an order, so an anonymous coin transfer can be matched to a purchase. */
  order(session: unknown, origin: string, sku: string): Promise<{ to: string; price: number; asset: string }>
  close(): void
}

/** What a slime is worth, in coins. */
const MOB_DROP = 25
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

  // The issuer address by default, so a restarted issuer is a different room and
  // the proofs made against the old one stop authenticating anywhere.
  const room = options.room ?? kei.address
  const sessions = createSessions({
    room,
    refillPerSecond: options.pressRateCap ?? DEFAULT_OBSERVATION_RATE,
    ...(options.pressBurst === undefined ? {} : { capacity: options.pressBurst }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  return {
    address: kei.address,
    room,

    catalogue() {
      return {
        issuer: kei.address,
        network: kei.network,
        coin: { asset: coins.id, symbol: coins.symbol, decimals: coins.decimals },
        exchange: { open: exchange, coinsPerKei: COINS_PER_KEI, minimum: MINIMUM_TOP_UP },
        upgrades: UPGRADES.map((upgrade) => ({ ...upgrade, asset: items.get(upgrade.sku)!.id })),
      }
    },

    challenge(address, origin) {
      return sessions.challenge(address, origin)
    },

    authenticate(proof, origin) {
      return sessions.authenticate(proof, origin)
    },

    press(session, origin) {
      return sessions.press(session, origin)
    },

    hit(session, origin, mob) {
      return sessions.hit(session, origin, mob)
    },

    async bank(session, origin) {
      // Taken synchronously, before the first `await`: two banks in flight
      // divide the tally rather than both selling it. The count is this
      // server's, and there is no argument here a caller could put a figure in.
      const { session: who, presses } = sessions.take(session, origin)

      try {
        const { perPress } = payoutFor(await ownedBy(kei, who.address, items))
        return await drops.add(who.address, presses * perPress)
      } catch (error) {
        // Nothing was published, so the presses were never spent. They go back
        // to the session that earned them and can be banked again.
        sessions.restore(who.id, presses)
        throw error
      }
    },

    async loot(session, origin, event) {
      // The event is one this server minted when it watched the mob die. The
      // caller names which kill, never which mob and never what it was worth.
      const { session: who, mob } = sessions.redeem(session, origin, event)
      try {
        return await drops.add(who.address, MOB_DROP)
      } catch (error) {
        sessions.unredeem(String(event), { session: who.id, address: who.address, mob })
        throw error
      }
    },

    order(session, origin, sku) {
      // The payer is the proven wallet, not a body field: an order names the
      // address whose incoming transfer will be matched to it, and letting a
      // caller name somebody else's is how a victim's payment delivers the
      // wrong item.
      const { address } = sessions.require(session, origin)
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

export { GameError } from './errors.js'

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
  /** Raw coin units. See the decimals check in `openShop` for why not a number. */
  price: bigint
  at: number
  /**
   * A payment for this order is being honoured right now.
   *
   * It is what stops a second arrival from delivering the same order twice, and
   * it is why the record outlives the payment: the order is the only thing that
   * says what the coins were for, so deleting it before delivery is known to
   * have worked destroys the one description of a debt the shop still owes.
   */
  settling: boolean
}

/**
 * Buying an upgrade is a coin transfer the player signs, and a mint the issuer
 * signs in response — the same two-signature shape as a Kei purchase, because
 * the game cannot sign for a player's wallet and never will (SPEC §6.3).
 *
 * A transfer carries no memo (decisions-m0 §4), so the intent is recorded here
 * first and matched to the arrival. The order is not the purchase: nothing is
 * delivered until the chain says the coins landed.
 *
 * Which leaves the shop holding one obligation it cannot argue its way out of.
 * A player's transfer is signed by the player, settled by the chain, and final;
 * the game does not hold their key and cannot reverse it. So once coins arrive
 * there are exactly two honest endings — the item, or the coins back — and every
 * branch in `settle` below reaches one of them. None of them keeps money and
 * delivers nothing, which is what this file used to do to the second buyer of a
 * supply-one item.
 */
function openShop(
  kei: Kei,
  coins: IssuerToken,
  items: ReadonlyMap<string, Item>,
): { order(address: string, sku: string): Promise<{ to: string; price: number; asset: string }>; close(): void } {
  // Whole coins are raw coins here: COIN has 0 decimals (shared/catalogue.ts),
  // so every figure below is both, and BigInt keeps it that way from the node's
  // raw decimal strings (SPEC §5.10) through to the comparison that decides
  // whether a purchase happened. Checked rather than assumed, because the day
  // the coin gains a decimal place these turn into float comparisons against raw
  // strings, and a price that is off by one unit is a shop that steals.
  if (coins.decimals !== 0) {
    throw new Error(
      `The shop compares coin amounts as whole units, and ${coins.symbol} has ${coins.decimals} decimals.`,
    )
  }

  const orders = new Map<string, Order>()

  /**
   * Copies nobody owns yet, read off the chain rather than counted here.
   *
   * `assetInfo` answers both halves in one call, in raw units, as decimal
   * strings — which is the only form a billion-unit cap survives. Items are
   * 0-decimal tokens (SPEC §7), so a raw unit is a copy. `null` is uncapped,
   * and uncapped is never sold out.
   */
  const unsoldCopies = async (item: Item): Promise<bigint | null> => {
    const info = await kei.client.node.assetInfo(item.id)
    if (!info || info.maxSupply === null) return null
    return BigInt(info.maxSupply) - BigInt(info.circulating)
  }

  /**
   * Coins the shop is not entitled to, going back to the account that sent them.
   *
   * The shop can sign this and only this: it holds the coins, and it has never
   * held the payer's key (SPEC §6.3). The amount crosses the SDK boundary as a
   * decimal string, because a BigInt prints exactly and a float does not.
   */
  const refund = async (to: string, amount: bigint, because: string): Promise<void> => {
    if (amount <= 0n) return
    await coins.transfer(to, amount.toString())
    console.warn(`[shop] returned ${amount} ${coins.symbol} to ${to}: ${because}.`)
  }

  /**
   * Honour one settled payment, or give it back.
   *
   * Awaited by nothing — the arrival comes from a chain subscription, not from a
   * request — so the `.catch` on the call below is the only thing between a
   * failed mint and Node's default for an unhandled rejection, which is to take
   * the whole game server down over one purchase. That is the same hazard, and
   * the same fix, as world-of-wonder's `dropCTRL.ts`.
   */
  const settle = async (from: string, paid: bigint): Promise<void> => {
    const order = orders.get(from)

    // Coins against no order: a payment for an order that already expired, one
    // sent by hand, or a second payment for an order being delivered. Keeping
    // them would be charging for nothing, so they go back.
    if (!order) return refund(from, paid, 'the shop had no open order for it')
    if (order.settling) return refund(from, paid, 'the order it was for is already being delivered')

    const upgrade = upgradeBySku(order.sku)
    const item = items.get(order.sku)
    // Orders only ever hold a sku `order()` accepted, so this cannot fire — but
    // returning the coins is the right answer even to a state that cannot happen.
    if (!upgrade || !item) return refund(from, paid, 'the shop no longer sells that')

    if (paid < order.price) {
      // The order stays open, so the right payment still lands the item. The
      // short one goes back rather than sitting here as an unrecorded windfall,
      // which is what a bare `return` made of it.
      return refund(from, paid, `${upgrade.name} costs ${order.price} coins and ${paid} arrived`)
    }

    order.settling = true
    try {
      await kei.items.mint(item.id, from)
    } catch (error) {
      // Supply can run out between the order and the payment, and a mint is a
      // chain round trip that can simply time out. Either way the player is
      // owed their coins, and this is the only place that can pay them.
      console.error(`[shop] the ${upgrade.name} for ${from} did not mint:`, error)
      orders.delete(from)
      return refund(from, paid, `the shop could not deliver the ${upgrade.name}`)
    }

    // Delivered, so the order is spent and the record can go.
    orders.delete(from)
    // The shop is a sink: coins spent here stop existing, which frees the
    // headroom they took under the cap (SPEC §5.6.6). Only the price is burned;
    // anything above it was never the shop's.
    await coins.burn(order.price.toString())
    await refund(from, paid - order.price, `it was more than the ${upgrade.name} costs`)
  }

  const stop = kei.on('asset-received', (arrival) => {
    if (arrival.asset !== coins.id) return
    // 0 decimals, so the SDK's display number is already the raw unit count.
    const paid = BigInt(arrival.amount)
    void settle(arrival.from, paid).catch((error) => {
      // Reached only when the coins could not be delivered *and* could not be
      // returned, which needs durable state to retry from and this demo has
      // none. Loud, because it is the one case where a player is out of pocket.
      console.error(`[shop] ${arrival.from} is owed ${paid} ${coins.symbol} and the shop could not settle it:`, error)
    })
  })

  return {
    async order(address, sku) {
      const upgrade = upgradeBySku(sku)
      const item = items.get(sku)
      if (!upgrade || !item) throw new GameError(`The shop does not sell "${sku}".`)

      const price = BigInt(upgrade.price)
      const open = orders.get(address)
      if (open?.settling) {
        const pending = upgradeBySku(open.sku)?.name ?? open.sku
        throw new GameError(`Your ${pending} is being delivered. Wait for it to land, then buy the next thing.`)
      }

      const [heldRaw, unsold] = await Promise.all([
        // Raw, from the node, rather than `balanceOf`'s number: this comparison
        // decides whether a player is told to go and spend 6,000 coins.
        kei.client.node.holderBalance(coins.id, address),
        unsoldCopies(item),
      ])
      const held = BigInt(heldRaw)
      if (held < price) {
        throw new GameError(
          `${upgrade.name} costs ${upgrade.price} coins and you have ${held}. Press the button a few more times.`,
        )
      }

      // Nothing is awaited from here to `orders.set`, which is what makes the
      // supply check and the reservation one step rather than two. Two steps is
      // the whole bug: read "one left", let a second caller read "one left", and
      // both are told to pay. There is one instance of this map and one thread
      // touching it — the Worker routes every request to one Durable Object
      // (worker/index.ts, `idFromName('button')`) — so a synchronous block is
      // genuinely indivisible here. It is still not the only defence, because it
      // cannot be: supply is on the chain and the chain has other writers, which
      // is what `settle`'s refund is for.
      for (const [who, order] of orders) {
        if (!order.settling && Date.now() - order.at > ORDER_TTL_MS) orders.delete(who)
      }
      let spokenFor = 0n
      for (const [who, order] of orders) {
        // This address's own order is about to be replaced, so it frees its copy.
        if (who !== address && order.sku === sku) spokenFor += 1n
      }
      if (unsold !== null && unsold - spokenFor <= 0n) throw new GameError(soldOut(upgrade, unsold))

      orders.set(address, { sku, price, at: Date.now(), settling: false })
      return { to: kei.address, price: upgrade.price, asset: coins.id }
    },
    close: stop,
  }
}

/**
 * The refusal a player reads instead of paying for something that cannot arrive.
 *
 * It has to say two things to be worth reading: that no coins moved, and whether
 * waiting would help. A copy held by an unfinished order comes back; one held by
 * another player's wallet does not.
 */
function soldOut(upgrade: { name: string; supply: number }, unsold: bigint): string {
  if (unsold > 0n) {
    return `Somebody is paying for the last ${upgrade.name} right now. Try again in a minute — nothing was charged.`
  }
  const only =
    upgrade.supply === 1
      ? 'There is only one on this network and it is owned.'
      : `All ${upgrade.supply} have been bought.`
  return `The ${upgrade.name} is sold out. ${only} Nothing was charged.`
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
