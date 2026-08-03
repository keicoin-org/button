/**
 * Every line of Kei in the client, in one file, so it can be read in one sitting.
 *
 * The shape to notice: there is no `getBalance` call to this game's server, and
 * no session. The browser holds a key, signs its own blocks, and reads its own
 * balances from the node. The server is asked exactly two things — what a press
 * is worth, and what an upgrade costs — and both are its business rather than
 * the chain's.
 *
 * The other thing to notice is what is missing. There is no save file. Upgrades
 * are items this wallet holds, so the progression is restored by reading the
 * chain, and it is restored just as well in a different browser, or in the
 * standalone wallet, or in a game this one has never heard of.
 */

import { Kei, type ClaimBundle, type PlayerToken, type WalletSummary } from 'kei-transaction'

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
import { joinArena, type ArenaSession } from './multiplayer.js'
import { ownershipSigner, playerSeed } from './ownership.js'

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
  loot(mob: string): Promise<void>
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

    // Button provisions the seed rather than letting the SDK do it, so the same
    // key can answer the arena's ownership challenge (`src/ownership.ts` says
    // what that costs). Same store, same key, same wallet as before.
    kei = await Kei.start({
      seed: playerSeed(catalogue.network),
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

  // Banking and mob drops both enter the SDK's one shared held-bundle map.
  // Serialize at that common boundary so no two claimAll sweeps can read and
  // submit the same proof concurrently.
  const addClaim = serialClaims<ClaimBundle>((bundle) => kei.claims.add(bundle))

  // ------------------------------------------------------------------- arena

  /**
   * The multiplayer session, when this deployment has a room.
   *
   * There is no third state. Either the catalogue advertised a room and every
   * press and bank goes through it, or it did not and the single-player HTTP
   * route is open. What this must never do is answer a room being unreachable
   * by posting to `/game/bank` instead — that route is closed while the room is
   * up, and a client that tried it would be asking to be paid for presses
   * nobody saw.
   */
  const multiplayer = catalogue.arena
  let arena: ArenaSession | null = null

  const connectArena = async (): Promise<ArenaSession | null> => {
    if (!multiplayer) return null
    if (arena) return arena
    const signer = await ownershipSigner(playerSeed(catalogue.network))
    arena = await joinArena({
      url: multiplayer.url,
      room: multiplayer.room,
      signer,
      onClosed(reason) {
        // Whatever this session had proved is gone with the socket. Presses
        // made from here are counted by this browser and observed by nobody,
        // which is what the next bank will find out and say.
        arena = null
        state.message = reason
        changed()
      },
    })
    return arena
  }

  if (multiplayer) {
    try {
      await connectArena()
    } catch (error) {
      // Playable, and honest about it: the button works, the presses stack up,
      // and nothing banks until the room is reachable again.
      say(error)
    }
  }

  // ------------------------------------------------------------------ banking

  let timer: ReturnType<typeof setTimeout> | undefined
  /**
   * Whether a batch is out. Owned here rather than read off the ledger, because
   * no ledger stage covers the whole of a bank: `banking` empties the instant
   * the proof arrives, and the claim that turns the proof into coins is written
   * after that. See `bank()` for what gets in through the gap.
   */
  let inFlight = false

  /** A bundle's amount is raw units; every other figure in this file is display units. */
  const paid = (bundle: ClaimBundle): number =>
    Number(bundle.amount) / 10 ** catalogue.coin.decimals

  /**
   * Single-player: the game is told a number and takes the client's word for it,
   * bounded by its own rate cap. Only reachable where no room was advertised.
   */
  const bankOverHttp = async (presses: number): Promise<ClaimBundle> => {
    const response = await fetch(at('/game/bank'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: kei.address, presses }),
    })
    const body = (await response.json()) as { bundle?: ClaimBundle; error?: string }
    if (body.error || !body.bundle) throw new Error(body.error ?? 'The game server sent no proof back.')
    return body.bundle
  }

  /**
   * Multiplayer: spend presses the room watched arrive, on a session that
   * proved this wallet.
   *
   * A dropped socket is reconnected here rather than at the moment it dropped,
   * because that is when it matters and because a reconnect loop against a
   * server that is down is worse than a player who is told once. Presses the
   * room already observed survive the disconnect and are still spendable; ones
   * made while it was down were seen by nobody, and the smaller number that
   * comes back is the honest answer to that.
   */
  const bankInArena = async (presses: number): Promise<ClaimBundle> => {
    const session = arena ?? (await connectArena())
    if (!session) throw new Error('The button room is not reachable, so nothing can be banked yet.')
    return (await session.bank(presses)).claim
  }

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

    let bundle: ClaimBundle
    try {
      bundle = multiplayer ? await bankInArena(presses) : await bankOverHttp(presses)
    } catch (error) {
      // Nothing was signed, so the presses are still owed. They go back to
      // where they were and the headline does not move.
      state.unbankedPresses += presses
      state.coins = bankingFailed(state.coins, expected)
      say(error)
      return
    }

    // What the chain will pay, rather than what the presses were hoped to be
    // worth: the server caps a bank that arrived too fast to be a hand
    // (server/game.ts's bank()), and the bundle carries the capped figure. The
    // headline drops to it here, once, at the moment the truth arrives.
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

  const press = (times = 1): void => {
    // The headline moves on this line, before anything is awaited. That is the
    // whole requirement: the number answers the finger, and it answers it as a
    // count of presses rather than as a balance.
    state.unbankedPresses += times
    state.coins = pressed(state.coins, times * state.perPress)
    // Told to the room as it happens, not totalled up at banking time — the
    // point of an observed press is that the server saw it arrive.
    arena?.press(times)
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
        const response = await fetch(at('/game/order'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: kei.address, sku }),
        })
        const order = (await response.json()) as { to?: string; price?: number; error?: string }
        if (order.error || !order.to || order.price === undefined) {
          throw new Error(order.error ?? 'The shop did not answer.')
        }
        // The player signs the payment. The shop signs the delivery. There is no
        // third arrangement in which one of them signs for the other.
        await coins.transfer(order.to, order.price)
        state.message = `Bought ${upgrade.name}. It will arrive in a moment.`
        changed()
      } catch (error) {
        say(error)
      }
    },

    async loot(mob) {
      try {
        const response = await fetch(at('/game/loot'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: kei.address, mob }),
        })
        const body = (await response.json()) as { bundle?: ClaimBundle; error?: string }
        if (body.error || !body.bundle) throw new Error(body.error ?? 'The mob dropped no claim proof.')

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
      arena?.close()
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
    async loot() {
		/* no chain, so there is no claimable drop */
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
