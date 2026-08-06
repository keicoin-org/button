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

import { Kei, KEI_DECIMALS, issuanceBurn, type ClaimBundle, type IssuerToken, type Item } from 'kei-transaction'
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
  /**
   * Pay for the presses this server observed. Returns the proof to claim with (§5.5).
   *
   * `batch` names the attempt. Two calls carrying the same one are the same
   * batch however many times the caller asks, which is what makes a retry after
   * a lost response safe.
   */
  bank(session: unknown, origin: string, batch: unknown): Promise<ClaimBundle>
  /** Collect a kill this server recorded, by the event id the kill returned. */
  loot(session: unknown, origin: string, event: unknown): Promise<ClaimBundle>
  /**
   * A starting balance for a proven wallet that has none.
   *
   * The node's faucet is not on the public RPC surface (`server/rpc.ts`), and
   * this is what replaces it: the same grant, given to an address that has
   * proved it holds its key, in an amount this server states and a caller cannot.
   */
  faucet(session: unknown, origin: string): Promise<{ granted: number }>
  /** Take an order, so an anonymous coin transfer can be matched to a purchase. */
  order(session: unknown, origin: string, sku: string): Promise<{ to: string; price: number; asset: string }>
  close(): void
}

/**
 * Assets this game issues: the currency, and one item type per upgrade.
 *
 * Counted off `UPGRADES` rather than written down, because the bill below is
 * priced from this number and a sixth upgrade must not leave it behind.
 */
const ISSUED_ASSETS = UPGRADES.length + 1

/**
 * What the next `assets` issuances burn, in whole Kei.
 *
 * SPEC §5.6.5: **the nth asset an account issues burns n Kei.** The first costs
 * 1, the sixth costs 6, so this game's six cost 21 between them — not the flat
 * 1,000 an asset that the grant here used to be sized against. That flat rule is
 * the one §5.6.5 says it *replaced*; no published version ever charged it, and
 * budgeting against it over-funds an issuer by two orders of magnitude and
 * teaches a developer to provision 500,000 Kei for a catalogue that costs
 * 125,751.
 *
 * The per-asset price comes from the SDK's own `issuanceBurn`, which is the same
 * function the ledger prices the block with, so this cannot drift from what the
 * chain will actually charge. `alreadyIssued` is the count the chain keeps for
 * the account, because the price is per account and does not reset.
 */
export function issuanceCost(alreadyIssued: number, assets: number): number {
  let raw = 0n
  for (let nth = 0; nth < assets; nth++) raw += issuanceBurn(alreadyIssued + nth)
  // Divided as a BigInt and only then made a number: every issuance burn is a
  // whole number of Kei, and 10^18 raw units do not survive a float.
  return Number(raw / 10n ** BigInt(KEI_DECIMALS))
}

/**
 * A new player's starting Kei, and how often one address may be given it.
 *
 * The figure is here rather than in the request, which is the entire lesson of
 * #30: the mock node's faucet took its amount from the caller and was mounted on
 * a public path, so two curls minted a million Kei and closed the shop for
 * everybody by exhausting COIN's max supply through the exchange desk.
 *
 * Ten Kei is what the mock's own default grant is, so a first-time visitor gets
 * exactly what they got before. At the posted rate it buys 10,000 coins, which
 * is a demo's worth of shopping and 0.001% of the coin cap — a hundred thousand
 * proven wallets would be needed to reach the cap this way, and each of them
 * costs a challenge, a signature and an hour's wait.
 */
const FAUCET_KEI = 10
const FAUCET_EVERY_MS = 60 * 60_000
/** Addresses remembered for the rate limit. Past this the oldest is forgotten. */
const MAX_FAUCET_RECORDS = 8_192

/** What a slime is worth, in coins. */
const MOB_DROP = 25
/** An order nobody paid for is forgotten after this long. */
const ORDER_TTL_MS = 120_000
/**
 * How long a published batch can still be asked for by its id.
 *
 * It is the window in which a client that lost the response can come back for
 * the proof it never received. Long enough to cover a reconnect, short enough
 * that the map is not a second ledger.
 */
const BATCH_TTL_MS = 5 * 60_000
/** Batches remembered. Past this the oldest is dropped and its retry refused. */
const MAX_REMEMBERED_BATCHES = 4_096

export async function startGame(options: GameOptions): Promise<Game> {
  const kei = await Kei.server({
    seed: options.seed,
    node: options.node,
    ...(options.network === undefined ? {} : { network: options.network }),
  })

  // Issuing is the one thing in Kei that is not free (SPEC §5.6.5), and this
  // game issues one currency and one item type per upgrade. On a real network
  // somebody funds this address once; on a mock the faucet does.
  //
  // How many it has issued already is on the chain, so it is read rather than
  // assumed to be zero: an issuer that has issued before is being funded for its
  // *next* six assets, which cost more than a fresh account's first six.
  const account = await kei.client.node.accountInfo(kei.address)
  const needed = issuanceCost(account?.issuedCount ?? 0, ISSUED_ASSETS)
  const held = await kei.balance()
  // The shortfall exactly. Nothing else here costs Kei — transfers, mints,
  // claims and burns are free forever — so a margin on top would be a figure
  // with no rule behind it, which is what the last one turned out to be.
  if (held < needed) await kei.faucet(needed - held)

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

  const grants = new Faucet(kei, options.now ?? Date.now)
  const shop = openShop(kei, coins, items)
  const drops = new DropBatch(coins, options.flushMs ?? 1_500)
  const batches = new BatchLog()

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

    async bank(session, origin, batch) {
      // Who is asking is settled before the batch is looked up, so a batch id
      // is never a way to read somebody else's proof by guessing it.
      const asking = sessions.require(session, origin)
      const id = batchId(batch)

      // Every line from here to `batches.begin` is synchronous, which is what
      // makes the lookup and the take one step: a second request carrying the
      // same id cannot get between them and take the tally a second time.
      const known = batches.find(id, asking.address)
      if (known) return known

      // Taken synchronously, before the first `await`: two banks in flight
      // divide the tally rather than both selling it. The count is this
      // server's, and there is no argument here a caller could put a figure in.
      const { session: who, presses } = sessions.take(session, origin)

      const paying = (async () => {
        try {
          const { perPress, pressesPerSecond } = payoutFor(await ownedBy(kei, who.address, items))
          // The same holdings read that prices a press also says how fast this
          // address may press: machines on the chain press faster than a hand, and
          // the ceiling has to count them or it clips the player who bought them.
          // This is the one place the figure comes from — the chain, never a request.
          sessions.machines(who.address, pressesPerSecond)
          return await drops.add(who.address, presses * perPress)
        } catch (error) {
          // Nothing was published, so the presses were never spent. They go back
          // to the session that earned them and can be banked again — under this
          // same id, which is why a failure forgets it rather than recording it.
          sessions.restore(who.id, presses)
          throw error
        }
      })()

      return batches.begin(id, who.address, paying)
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

    async faucet(session, origin) {
      // A grant is money, so it goes to a wallet that has proved it holds its
      // key — never to an address out of a request body, and never in an amount
      // out of one either.
      const { address } = sessions.require(session, origin)
      return grants.give(address)
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

// -------------------------------------------------------------------- batches

/**
 * Which batch a bank is, so asking twice is asking once.
 *
 * `bank()` does two irreversible things: it empties the session's press tally,
 * and it puts an entitlement in an issuer block that is on the chain forever.
 * Both are done before the response is written, and a response can be lost — to
 * a flaky tab, a 502 in front of the Worker, an eviction between the commit and
 * the reply. Without an id for the attempt, the client's only options are to
 * give up on presses it may well have been paid for, or to bank again and be
 * paid twice; and the proof for the first payment, which is the only way to
 * collect it, is gone with the response.
 *
 * So the caller names the attempt, and this remembers what that name bought. A
 * retry under the same id is handed the same proof, and no second root is
 * published. It is the idiom create-kei-game's `/game/earn` settled on (its PR
 * #47) — the key is checked before anything is spent, an attempt still running
 * is joined rather than started again, and an attempt that failed is forgotten
 * so the same id can honestly be tried once more.
 *
 * A batch is remembered for `BATCH_TTL_MS` and no longer, which is the honest
 * limit of it: past that a retry is refused rather than answered wrongly, and
 * this map never becomes a second ledger of who is owed what.
 */
class BatchLog {
  private open = new Map<string, { address: string; bundle: Promise<ClaimBundle> }>()
  private published = new Map<string, { address: string; bundle: ClaimBundle; at: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  /** The proof this id already bought, or nothing if it has bought none yet. */
  find(id: string, address: string): Promise<ClaimBundle> | undefined {
    this.forget()

    const done = this.published.get(id)
    if (done) return Promise.resolve(mine(done.address, address, done.bundle))

    const running = this.open.get(id)
    if (running) return mine(running.address, address, running.bundle)

    return undefined
  }

  /** Record an attempt, and remember its proof if it publishes one. */
  begin(id: string, address: string, paying: Promise<ClaimBundle>): Promise<ClaimBundle> {
    this.open.set(id, { address, bundle: paying })
    return paying.then(
      (bundle) => {
        this.open.delete(id)
        if (this.published.size >= MAX_REMEMBERED_BATCHES) {
          const oldest = this.published.keys().next()
          if (!oldest.done) this.published.delete(oldest.value)
        }
        this.published.set(id, { address, bundle, at: this.now() })
        return bundle
      },
      (error: unknown) => {
        // Nothing was published under this id, so nothing is remembered under
        // it. The presses went back to the session and the same id may be sent
        // again — which is what makes the retry the client is about to make the
        // *same* batch rather than a new one.
        this.open.delete(id)
        throw error
      },
    )
  }

  private forget(): void {
    const at = this.now()
    for (const [id, batch] of this.published) {
      if (at - batch.at > BATCH_TTL_MS) this.published.delete(id)
    }
  }
}

/** A batch is answered to the address that opened it and to no other. */
function mine<T>(owner: string, asking: string, value: T): T {
  if (owner !== asking) throw new GameError('That batch was opened by a different wallet.')
  return value
}

/**
 * A batch id off the wire.
 *
 * Required, because a bank without one cannot be retried: the tally it consumed
 * is gone and the proof it published can no longer be asked for. Refusing is
 * the cheap failure; the alternative is a player either short their presses or
 * paid twice for them.
 */
function batchId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (id.length === 0) {
    throw new GameError('A bank names the batch it is paying for. Send a batch id, and send the same one if you retry.')
  }
  if (id.length > 64 || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new GameError('A batch id is up to 64 letters, digits, ".", "_" or "-".')
  }
  return id
}

// -------------------------------------------------------------------- faucet

/**
 * The only mint a stranger can reach, and everything about it is this server's.
 *
 * Before #30 the mock node's faucet was on the public `/rpc` path with its
 * amount taken from the request body, which is an unauthenticated mint with no
 * ceiling. The route is closed now (`server/rpc.ts`), and this is what a new
 * player gets instead. Three things are the server's and not the caller's:
 *
 *   - **who** — a session, so the address has proved it holds its key;
 *   - **how much** — `FAUCET_KEI`, a constant, with no field for a figure;
 *   - **how often** — once an hour per address, and only into an empty wallet.
 *
 * A wallet that is not empty is refused rather than topped up, so grants cannot
 * be accumulated by an address that keeps asking.
 */
class Faucet {
  private given = new Map<string, number>()

  constructor(
    private readonly kei: Kei,
    private readonly now: () => number,
  ) {}

  async give(address: string): Promise<{ granted: number }> {
    if (this.kei.network === 'mainnet') {
      throw new GameError('There is no faucet on mainnet. Fund this wallet and come back.')
    }

    const at = this.now()
    const last = this.given.get(address)
    if (last !== undefined && at - last < FAUCET_EVERY_MS) {
      throw new GameError('The faucet gives one grant an hour to an address. Press the button in the meantime.')
    }

    // Read off the chain, so "empty" is the chain's answer rather than this
    // server's memory of it — a restarted issuer must not hand a funded wallet
    // a second grant just because it has forgotten the first.
    const account = await this.kei.client.node.accountInfo(address)
    if (account !== null && BigInt(account.balance) > 0n) {
      throw new GameError('That wallet already has Kei. The faucet is for an empty one.')
    }

    if (this.given.size >= MAX_FAUCET_RECORDS) {
      const oldest = this.given.keys().next()
      if (!oldest.done) this.given.delete(oldest.value)
    }
    // Written before the grant, not after: a grant that lands and then fails to
    // be recorded is a second grant on the next request.
    this.given.set(address, at)

    // The amount is this server's. `node.faucet` takes one, and the fix is that
    // nothing reachable from outside gets to fill it in.
    await this.kei.client.node.faucet(address, toRawKei(FAUCET_KEI))
    return { granted: FAUCET_KEI }
  }
}

/** Whole Kei as the raw decimal string the node interface takes (SPEC §5.10). */
function toRawKei(amount: number): string {
  return (BigInt(amount) * 10n ** BigInt(KEI_DECIMALS)).toString()
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
