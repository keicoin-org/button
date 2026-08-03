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

export interface ShopRow extends Upgrade {
  asset: string
  owned: number
  affordable: boolean
}

export interface EconomyState {
  address: string
  network: string
  /** False when the node or the game server could not be reached. */
  online: boolean
  kei: number
  coins: number
  /** Presses this browser has made and not yet banked. */
  unbanked: number
  /**
   * Coins this browser has pressed for and the chain has not paid out yet —
   * presses still unbanked, plus whatever is in flight. Shown beside the
   * balance and never added to it: `coins` is what the chain says, and this is
   * what is still owed. Drained by real confirmations rather than by `bank`
   * starting, so it does not blink to zero while a batch is in flight.
   */
  pendingCoins: number
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
    coins: 0,
    unbanked: 0,
    pendingCoins: 0,
    banking: false,
    perPress: 1,
    pressesPerSecond: 0,
    claiming: 0,
    exchange: { open: false, coinsPerKei: 0, minimum: 0 },
    upgrades: [],
    message: null,
  }

  const changed = (): void => {
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
    state.coins = held?.amount ?? 0
    state.claiming = summary.pending.length

    const owned: Record<string, number> = {}
    state.upgrades = catalogue.upgrades.map((upgrade) => {
      const count = summary.items.find((item) => item.asset === upgrade.asset)?.count ?? 0
      if (count > 0) owned[upgrade.sku] = count
      return { ...upgrade, owned: count, affordable: state.coins >= upgrade.price }
    })

    const payout = payoutFor(owned)
    state.perPress = payout.perPress
    state.pressesPerSecond = payout.pressesPerSecond
    changed()
  }

  apply(await kei.wallet.summary())
  kei.wallet.on('change', apply)
  kei.on('error', say)

  // ------------------------------------------------------------------ banking

  let timer: ReturnType<typeof setTimeout> | undefined

  /** A bundle's amount is raw units; every other figure in this file is display units. */
  const paid = (bundle: ClaimBundle): number =>
    Number(bundle.amount) / 10 ** catalogue.coin.decimals

  const bank = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const presses = state.unbanked
    if (presses <= 0 || state.banking) return

    state.unbanked = 0
    state.banking = true
    changed()
    try {
      const response = await fetch(at('/game/bank'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: kei.address, presses }),
      })
      const body = (await response.json()) as { bundle?: ClaimBundle; error?: string }
      if (body.error || !body.bundle) throw new Error(body.error ?? 'The game server sent no proof back.')

      // From here the game is not involved. The bundle is an entitlement, and
      // the claim that collects it is written by this wallet, from this account,
      // in parallel with every other player claiming off the same root (§5.5).
      await kei.claims.add(body.bundle)
      // Drained by what the chain actually paid, not by what the presses were
      // hoped to be worth: the server caps a bank that arrived too fast to be
      // a hand (server/game.ts's bank()), and the bundle carries the capped
      // figure. Those coins have landed, so they are no longer owed.
      state.pendingCoins = Math.max(0, state.pendingCoins - paid(body.bundle))
      state.message = null
    } catch (error) {
      // Nothing was minted, so the presses are still owed. Put them back.
      // `pendingCoins` is untouched — it was never drained for this batch.
      state.unbanked += presses
      say(error)
    } finally {
      state.banking = false
      changed()
    }
  }

  const press = (times = 1): void => {
    state.unbanked += times
    state.pendingCoins += times * state.perPress
    if (state.unbanked >= BANK_AFTER_PRESSES) void bank()
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
        await kei.claims.add(body.bundle)
        state.message = 'Claimed 25 coins from the mob drop.'
        changed()
      } catch (error) {
        say(error)
      }
    },

    async topUp(amount) {
      try {
        state.message = null
        if ((await kei.balance()) < amount && catalogue.network !== 'mainnet') await kei.faucet()
        await kei.pay({ to: catalogue.issuer, amount })
        state.message = `Paid ${amount} Kei. Coins on the way.`
        changed()
      } catch (error) {
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
      state.unbanked += times
      // Owed by a game that is not there, which is the honest reading of it:
      // the message line already says nothing is being banked.
      state.pendingCoins += times * state.perPress
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
