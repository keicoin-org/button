/**
 * Every line of Kei in the client, in one file, so it can be read in one sitting.
 *
 * The shape to notice: there is no `getBalance` call to this game's server. The
 * browser holds a key, signs its own blocks, and reads its own balances from the
 * node. The server is asked exactly two things — what a press is worth, and what
 * an upgrade costs — and both are its business rather than the chain's.
 *
 * There *is* a session, and what it is for is worth being precise about. The
 * server has to know two things this file cannot be trusted to state: which
 * wallet is asking, and how many presses actually happened. So this browser
 * proves its address once by signing a challenge, and thereafter every press is
 * a request the server counts for itself. The session authorises a payout. It
 * never carries money, and the claim it leads to is still written by this
 * wallet, from its own chain, exactly as before.
 *
 * The other thing to notice is what is missing. There is no save file. Upgrades
 * are items this wallet holds, so the progression is restored by reading the
 * chain, and it is restored just as well in a different browser, or in the
 * standalone wallet, or in a game this one has never heard of.
 */

import { Kei, type ClaimBundle, type PlayerToken, type WalletSummary } from 'kei-transaction'

import type { OwnershipChallengeMessage } from '../shared/ownership.js'

import {
  payoutFor,
  type CataloguePayload,
  type Upgrade,
} from '../shared/catalogue.js'
import {
  banked,
  bankingFailed,
  bankingStarted,
  canAfford,
  claimExpected,
  claimFailed,
  clearingNote,
  emptyLedger,
  pressed,
  purchaseBlock,
  reconcileConfirmed,
  type CoinLedger,
} from './ledger.js'
import { serialClaims } from './claim-queue.js'
import { sign } from './ownership.js'

export interface ShopRow extends Upgrade {
  asset: string
  owned: number
  /** Confirmed coins only. Nothing still clearing has ever made a row affordable. */
  affordable: boolean
  /** How far off the row is, and whether waiting would cover it. Null when buyable. */
  note: string | null
}

export interface EconomyState {
  address: string
  network: string
  /** False when the node or the game server could not be reached. */
  online: boolean
  kei: number
  /**
   * Every coin this browser knows about, by how far along it is. `confirmed` is
   * the balance; the rest is owed. Nothing outside `src/ledger.ts` is allowed to
   * add them together and call the result a balance.
   */
  coins: CoinLedger
  /** Presses this browser has made and not yet handed to the game. */
  unbankedPresses: number
  /**
   * A batch is out: somewhere between asking the game to price it and this
   * wallet's claim for it being written. It is one flag for the whole of that,
   * because `coins.banking` empties as soon as the proof arrives and the claim
   * is still to come — the screen would say the batch had landed while the part
   * that lands it had not run.
   */
  banking: boolean
  perPress: number
  pressesPerSecond: number
  claiming: number
  exchange: { open: boolean; coinsPerKei: number; minimum: number }
  upgrades: ShopRow[]
  /** One sentence for the player. Errors from the SDK arrive here verbatim. */
  message: string | null
}

export interface Economy {
  readonly state: EconomyState
  press(times?: number): void
  buy(sku: string): Promise<void>
  /** Hit a mob once. True when the server said it died and paid the drop. */
  hit(mob: string): Promise<boolean>
  topUp(kei: number): Promise<void>
  on(listener: (state: EconomyState) => void): void
  close(): void
}

/** Bank after this many presses, or this long, whichever comes first. */
const BANK_AFTER_PRESSES = 20
const BANK_AFTER_MS = 3_000

/**
 * Everything is addressed relative to wherever this page is served from, because
 * it is served from two places: `/` in local development, and
 * `keicoin.org/examples/button/` in production. Absolute paths would work in
 * exactly one of them.
 */
const base = location.pathname.replace(/\/$/, '')
const at = (path: string): string => `${base}${path}`

/** POST JSON and read the answer, with the server's own sentence on a refusal. */
async function post<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(at(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = (await response.json()) as T & { error?: string }
  // SPEC §6.1: the server's refusals are sentences that state their own fix, so
  // they are surfaced as written rather than replaced with a status code.
  if (body.error) throw new Error(body.error)
  return body
}

export async function connect(): Promise<Economy> {
  const listeners: Array<(state: EconomyState) => void> = []
  const state: EconomyState = {
    address: '',
    network: 'offline',
    online: false,
    kei: 0,
    coins: emptyLedger(),
    unbankedPresses: 0,
    banking: false,
    perPress: 1,
    pressesPerSecond: 0,
    claiming: 0,
    exchange: { open: false, coinsPerKei: 0, minimum: 0 },
    upgrades: [],
    message: null,
  }

  const changed = (): void => {
    // Every row is re-priced against the ledger on every change, so there is no
    // path where a press moves the headline and leaves a row saying something
    // the confirmed balance does not support.
    for (const row of state.upgrades) {
      row.affordable = canAfford(state.coins, row.price)
      row.note = clearingNote(state.coins, row.price)
    }
    for (const listener of listeners) listener(state)
  }
  const say = (error: unknown): void => {
    // SPEC §6.1: every error is a sentence that states its own fix, so it is
    // shown as written rather than replaced with "something went wrong".
    state.message = error instanceof Error ? error.message : String(error)
    changed()
  }

  let catalogue: CataloguePayload
  let kei: Kei
  let coins: PlayerToken
  try {
    catalogue = (await (await fetch(at('/game/catalogue'))).json()) as CataloguePayload
    state.exchange = catalogue.exchange
    state.network = catalogue.network

    kei = await Kei.start({
      node: `${location.origin}${at('/rpc')}`,
      network: catalogue.network as 'mock' | 'testnet',
    })
    coins = await kei.token(catalogue.coin.asset)
  } catch (error) {
    // Practice mode: the button still works, and says plainly that nothing is
    // landing. SPEC §8 wants this playable with the server down, and a game that
    // shows a blank screen because a fetch failed is not that.
    state.message =
      error instanceof Error && !/Failed to fetch|NetworkError/.test(error.message)
        ? error.message
        : 'No game server here — presses are not being banked. Start one with: bun run dev'
    return offline(state, listeners, changed)
  }

  state.address = kei.address
  state.online = true

  // On a mock chain a new player funds themselves, which is what a testnet
  // faucet is for (SPEC §12). On mainnet this is the one human step there is.
  if ((await kei.balance()) === 0 && catalogue.network !== 'mainnet') {
    await kei.faucet().catch(() => undefined)
  }

  const apply = (summary: WalletSummary): void => {
    const held = summary.tokens.find((token) => token.asset === catalogue.coin.asset)
    state.kei = summary.kei
    // The chain's figure lands in `confirmed`, and the rise it represents comes
    // straight out of `settling` — so a claim landing moves coins between two
    // stages instead of appearing in both.
    state.coins = reconcileConfirmed(state.coins, held?.amount ?? 0)
    state.claiming = summary.pending.length

    const owned: Record<string, number> = {}
    state.upgrades = catalogue.upgrades.map((upgrade) => {
      const count = summary.items.find((item) => item.asset === upgrade.asset)?.count ?? 0
      if (count > 0) owned[upgrade.sku] = count
      // `changed()` prices it; affordability is never computed in two places.
      return { ...upgrade, owned: count, affordable: false, note: null }
    })

    const payout = payoutFor(owned)
    state.perPress = payout.perPress
    state.pressesPerSecond = payout.pressesPerSecond
    changed()
  }

  apply(await kei.wallet.summary())
  kei.wallet.on('change', apply)
  kei.on('error', say)

  // ------------------------------------------------------------------ session

  /**
   * Prove this address to the server, once, and hold the id it gives back.
   *
   * Every request that could pay this wallet carries that id and nothing else —
   * no address, no press count, no mob name. What the id is worth is entirely
   * what the server watched the session do, which is the whole point of it.
   *
   * The proof is one signature over a challenge the server issued, bound to this
   * origin, this running issuer, and a nonce good for one use. It is not a
   * bearer token for anything else: it authorises nothing on the chain, and this
   * wallet still signs its own claims.
   */
  let session: string | null = null
  let opening: Promise<string> | null = null

  const openSession = (): Promise<string> => {
    opening ??= (async () => {
      const { challenge } = await post<{ challenge: OwnershipChallengeMessage }>('/game/session/challenge', {
        address: kei.address,
      })
      const proof = await sign(kei, challenge)
      const opened = await post<{ session: string }>('/game/session', { proof })
      session = opened.session
      return opened.session
    })().finally(() => {
      opening = null
    })
    return opening
  }

  /**
   * Run something with a session, and re-prove once if the server says there is
   * not one any more.
   *
   * A reconnect costs a signature and nothing else — in particular it does not
   * reset the observation ceiling, which the server keys on the proven address
   * rather than on the session, so dropping and re-proving is not a way to be
   * watched harder.
   */
  const withSession = async <T>(run: (id: string) => Promise<T>): Promise<T> => {
    const id = session ?? (await openSession())
    try {
      return await run(id)
    } catch (error) {
      if (!(error instanceof Error) || !/session/i.test(error.message) || session !== id) throw error
      session = null
      return run(await openSession())
    }
  }

  try {
    await openSession()
  } catch (error) {
    // The chain is reachable and the game server is not willing to watch this
    // wallet. Presses still count on screen and still bank nothing, which is the
    // same honest state practice mode is in.
    say(error)
  }

  // Banking and mob drops both enter the SDK's one shared held-bundle map.
  // Serialize at that common boundary so no two claimAll sweeps can read and
  // submit the same proof concurrently.
  const addClaim = serialClaims<ClaimBundle>((bundle) => kei.claims.add(bundle))

  // ------------------------------------------------------------------ banking

  let timer: ReturnType<typeof setTimeout> | undefined
  /**
   * Whether a batch is out. Owned here rather than read off the ledger, because
   * no ledger stage covers the whole of a bank: `banking` empties the instant
   * the proof arrives, and the claim that turns the proof into coins is written
   * after that. See `bank()` for what gets in through the gap.
   */
  let inFlight = false

  /**
   * The name of the batch currently being banked, held across its retries.
   *
   * A bank is not safe to simply repeat. By the time the server can answer it
   * has already emptied the tally it was paid for and put the entitlement in a
   * block, and the proof that collects that entitlement exists only in the
   * response — so a response lost on the way back is coins committed on the
   * chain that nothing can ever claim. Naming the attempt is what lets the same
   * attempt be asked for again: the server answers a repeat with the proof it
   * already published rather than publishing a second one.
   *
   * It is minted once per batch and kept until that batch is home, which is why
   * it is out here rather than inside `runBank`. Cleared on success, so the next
   * batch is a new one; kept on failure, so the next try is this one again.
   */
  let batch: string | null = null
  const nameBatch = (): string => (batch ??= crypto.randomUUID())

  /** A bundle's amount is raw units; every other figure in this file is display units. */
  const paid = (bundle: ClaimBundle): number =>
    Number(bundle.amount) / 10 ** catalogue.coin.decimals

  /**
   * Ask the game to price a batch, take the proof, write the claim.
   *
   * Only `bank()` calls this, and only one call is ever running: every stage
   * move in here assumes it is the only thing moving them.
   */
  const runBank = async (presses: number): Promise<void> => {
    // Both figures move together and are remembered together, because if the
    // fetch fails they both go back.
    const expected = state.coins.unbanked
    state.unbankedPresses = 0
    state.coins = bankingStarted(state.coins)
    changed()

    await settled()

    const named = nameBatch()

    let bundle: ClaimBundle
    try {
      // No count goes out. The server pays for the presses it watched arrive,
      // and this browser's own tally is a prediction of that figure rather than
      // an instruction — which is why the reconciliation below exists.
      const body = await withSession((id) =>
        post<{ bundle?: ClaimBundle }>('/game/bank', { session: id, batch: named }),
      )
      if (!body.bundle) throw new Error('The game server sent no proof back.')
      bundle = body.bundle
    } catch (error) {
      // What failed may or may not have been signed — a connection refused
      // before the request left and a response lost on the way back arrive here
      // as the same rejection, and this side cannot tell them apart. So the
      // presses go back to be asked for again, and the batch keeps its name:
      // if the server did publish, the next attempt is handed that same proof
      // instead of a second one, and if it did not, the next attempt is the
      // first one that reaches it.
      state.unbankedPresses += presses
      state.coins = bankingFailed(state.coins, expected)
      say(error)
      return
    }

    // Home. The next batch is a different batch and gets its own name.
    batch = null

    // What the chain will pay, rather than what the presses were hoped to be
    // worth. The two differ whenever a press did not reach the server or was
    // refused by its observation ceiling, and the bundle carries the figure the
    // server actually saw. The headline drops to it here, once, at the moment
    // the truth arrives.
    const amount = paid(bundle)
    state.coins = banked(state.coins, expected, amount)
    state.message = null
    changed()

    try {
      // From here the game is not involved. The bundle is an entitlement, and
      // the claim that collects it is written by this wallet, from this account,
      // in parallel with every other player claiming off the same root (§5.5).
      // Nothing is drained here: `reconcileConfirmed` takes these coins out of
      // `settling` when the chain's own figure rises, which is the same event
      // seen from the side that can be trusted.
      await addClaim(bundle)
    } catch (error) {
      // They leave the tally rather than going back to `unbanked` — the game
      // already paid for those presses, and pressing them again is not what
      // happened. The SDK keeps the bundle it was handed, so it is still listed
      // by `claims.pending()` and the next `claims.add` retries it; the coins
      // come back as a rise in the chain's figure if that retry lands. Counting
      // them as clearing meanwhile would be a promise this browser cannot keep.
      state.coins = claimFailed(state.coins, amount)
      say(error)
    }
    changed()
  }

  const bank = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = undefined
    // One batch at a time, and one batch means all three steps of it. A second
    // bank starting while the first is between its proof and its claim would
    // reach a second `kei.claims.add`, and the SDK claims out of one shared map
    // of held bundles: both calls run `claimAll()`, both can read the same
    // bundle before either has submitted it, and the loser gets told the root is
    // already claimed. That failure then rolls back this file's `settling` by
    // its own batch's amount, which is not the amount that failed.
    //
    // The presses that arrived meanwhile stay counted and unbanked, and the
    // timer goes back rather than being dropped: nothing else would come back
    // for them, so a player who presses twice during a bank and then stops
    // would be owed them forever. Pressing again once the batch is home banks
    // them on that press; stopping banks them on this timer.
    if (inFlight) {
      timer = setTimeout(() => void bank(), BANK_AFTER_MS)
      return
    }
    const presses = state.unbankedPresses
    if (presses <= 0) return

    inFlight = true
    state.banking = true
    try {
      await runBank(presses)
    } finally {
      inFlight = false
      state.banking = false
      changed()
    }
  }

  /**
   * Tell the server a press happened — one request, one press.
   *
   * A press is worth coins, so the count has to be something the server saw
   * rather than something this file asserts. One request each is the honest
   * reading of "the server counted them" over HTTP, and it is what makes the
   * batch below a *report of what landed* rather than an instruction.
   *
   * A refusal is not rolled back here. The optimistic coins added by `press()`
   * are reconciled by the bank, which pays what the server observed; unwinding
   * them twice would take the same coins off the headline twice.
   */
  const inFlightPresses = new Set<Promise<unknown>>()

  const observe = (times: number): void => {
    for (let index = 0; index < times; index++) {
      const sent = withSession((id) => post('/game/press', { session: id })).catch(say)
      inFlightPresses.add(sent)
      void sent.finally(() => inFlightPresses.delete(sent))
    }
  }

  /**
   * Wait for every press already sent to have landed.
   *
   * Without this the twentieth press and the bank it triggers race each other,
   * and a bank that overtakes its own presses is paid for fewer than happened.
   * They are not lost — the server counts them for the next bank — but the
   * headline would drop and then recover, which reads as the game losing coins.
   */
  const settled = (): Promise<unknown> => Promise.all([...inFlightPresses])

  const press = (times = 1): void => {
    // The headline moves on this line, before anything is awaited. That is the
    // whole requirement: the number answers the finger, and it answers it as a
    // count of presses rather than as a balance.
    state.unbankedPresses += times
    state.coins = pressed(state.coins, times * state.perPress)
    observe(times)
    if (state.unbankedPresses >= BANK_AFTER_PRESSES) void bank()
    else timer ??= setTimeout(() => void bank(), BANK_AFTER_MS)
    changed()
  }

  // Auto-pressers press. They are worth exactly what a finger is worth, because
  // the payout is read off the same chain either way.
  const auto = setInterval(() => {
    if (state.pressesPerSecond > 0) press(state.pressesPerSecond)
  }, 1_000)

  return {
    state,

    press,

    async buy(sku) {
      const upgrade = state.upgrades.find((row) => row.sku === sku)
      if (!upgrade) return

      // Confirmed coins only, and refused here rather than by the server. The
      // server checks the chain and remains the authority — but a player whose
      // headline reads 400 because 300 of it is clearing gets told which 400
      // that was, instead of an order they cannot pay for.
      const refusal = purchaseBlock(state.coins, upgrade.name, upgrade.price)
      if (refusal !== null) {
        state.message = refusal
        changed()
        return
      }

      try {
        state.message = null
        // The order is placed for the proven wallet, so the transfer the shop
        // waits for is the one this browser is about to sign and no other.
        const order = await withSession((id) =>
          post<{ to?: string; price?: number }>('/game/order', { session: id, sku }),
        )
        if (!order.to || order.price === undefined) throw new Error('The shop did not answer.')
        // The player signs the payment. The shop signs the delivery. There is no
        // third arrangement in which one of them signs for the other.
        await coins.transfer(order.to, order.price)
        state.message = `Bought ${upgrade.name}. It will arrive in a moment.`
        changed()
      } catch (error) {
        say(error)
      }
    },

    async hit(mob) {
      try {
        // A slime takes several hits and the server counts them, so a drop is
        // paid for a fight this server watched rather than for a claim that one
        // happened. The kill comes back as an event id — the only thing
        // `/game/loot` accepts, and good for one collection.
        const blow = await withSession((id) => post<{ event?: string }>('/game/hit', { session: id, mob }))
        if (!blow.event) return false

        const body = await withSession((id) =>
          post<{ bundle?: ClaimBundle }>('/game/loot', { session: id, event: blow.event }),
        )
        if (!body.bundle) throw new Error('The mob dropped no claim proof.')

        // A drop is owed exactly like a banked press is, so it goes through the
        // same stage. Registering it before claiming is what keeps the chain's
        // next rise from draining somebody else's coins out of `settling`.
        const amount = paid(body.bundle)
        state.coins = claimExpected(state.coins, amount)
        state.message = `Claiming ${Math.floor(amount)} coins from the mob drop.`
        changed()
        try {
          await addClaim(body.bundle)
        } catch (error) {
          state.coins = claimFailed(state.coins, amount)
          throw error
        }
        state.message = `Claimed ${Math.floor(amount)} coins from the mob drop.`
        changed()
      } catch (error) {
        say(error)
      }
      return true
    },

    async topUp(amount) {
      // A payment the issuer is not watching for, or one it is going to ignore
      // as a rounding error, buys nothing — and coins registered as owed for it
      // would sit in `settling` forever, since nothing is ever going to confirm
      // them. Both are refused here rather than paid for.
      if (!state.exchange.open) {
        state.message = 'The exchange desk is closed. Press the button instead.'
        changed()
        return
      }
      if (amount < state.exchange.minimum) {
        state.message = `The desk takes ${state.exchange.minimum} Kei at a time or more.`
        changed()
        return
      }

      // The issuer mints against this payment, and that mint reaches the wallet
      // as a rise in the chain's figure. Every rise is drained out of
      // `settling`, so the coins it will pay for are put there before the
      // payment goes out — registering them afterwards leaves a window in which
      // the mint arrives first and drains a banked press instead.
      const owed = amount * state.exchange.coinsPerKei
      state.coins = claimExpected(state.coins, owed)
      state.message = null
      changed()

      try {
        if ((await kei.balance()) < amount && catalogue.network !== 'mainnet') await kei.faucet()
        await kei.pay({ to: catalogue.issuer, amount })
        state.message = `Paid ${amount} Kei. Coins on the way.`
        changed()
      } catch (error) {
        // Nothing was paid, so nothing is owed for it.
        state.coins = claimFailed(state.coins, owed)
        say(error)
      }
    },

    on(listener) {
      listeners.push(listener)
    },

    close() {
      clearInterval(auto)
      if (timer) clearTimeout(timer)
      kei.close()
    },
  }
}

/** No server, no chain: the button still works and says why nothing is landing. */
function offline(
  state: EconomyState,
  listeners: Array<(state: EconomyState) => void>,
  changed: () => void,
): Economy {
  return {
    state,
    press(times = 1) {
      state.unbankedPresses += times
      // Counted and unbanked, which is the honest reading of it: there is no
      // game to bank them, so they stay in the stage that means "owed", nothing
      // is ever confirmed, and nothing in the shop becomes affordable.
      state.coins = pressed(state.coins, times * state.perPress)
      changed()
    },
    async buy() {
      /* nothing to buy without a shop */
    },
    async hit() {
      // No server watched the fight, so there is nothing to be paid for. The
      // slime stays where it is rather than vanishing for nothing.
      return false
    },
    async topUp() {
      /* nothing to pay without a chain */
    },
    on(listener) {
      listeners.push(listener)
    },
    close() {
      /* nothing running */
    },
  }
}
