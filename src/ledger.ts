/**
 * Where a coin is, and what may be said about it.
 *
 * A press is worth something the instant it happens, and it is worth nothing
 * spendable until the chain has accepted a claim for it. Those are two different
 * facts, the screen has to show both, and a game that shows one of them twice is
 * lying about the other. So the stages between a press and a balance are named
 * here, and every figure drawn anywhere is derived from that one shape.
 *
 * SPEC §5.5: a unit a player is told they own is backed by accepted chain state.
 * `confirmed` is the only field that is, so it is the only one called a balance,
 * and `canAfford` reads nothing else.
 *
 * Pure arithmetic on purpose — no SDK, no canvas, no `location` — so the
 * semantics can be tested without a browser or a chain.
 */

/**
 * The three queues a coin passes through, plus the chain's own figure. They are
 * the loop in the README with the money attached: press, bank, claim.
 */
export interface CoinLedger {
  /**
   * Accepted by the chain. The player's, spendable, and the only figure any
   * purchase is allowed to look at.
   */
  confirmed: number
  /** Counted by this browser for presses the game has not been asked to pay for yet. */
  unbanked: number
  /** Presses the game is pricing right now. No proof back yet. */
  banking: number
  /**
   * On their way and not here: something has been set going that the chain is
   * expected to pay out, and it has not paid out yet. Usually that is a proof
   * the issuer has signed and this wallet's claim for it; for a top-up it is a
   * payment to the issuer, registered before `kei.pay` rather than after, so the
   * mint has something to be drained out of when it arrives. The stage does not
   * promise the issuer has signed — it promises nothing else may spend these.
   */
  settling: number
}

export function emptyLedger(): CoinLedger {
  return { confirmed: 0, unbanked: 0, banking: 0, settling: 0 }
}

/**
 * Earned and not yet on the chain: owed rather than owned. Every stage before
 * `confirmed`, because from the player's side they are the same fact — these
 * coins cannot buy anything — and only the reason differs.
 */
export function pendingCoins(ledger: CoinLedger): number {
  return ledger.unbanked + ledger.banking + ledger.settling
}

/**
 * The headline figure, and the only one that moves on the press itself.
 *
 * It is a tally and not a balance, which is why nothing in this file will call
 * it one: it is what the counter has counted, and part of it is still a claim
 * the chain has not agreed to. The screen prints it under the word COUNTED and
 * prints `spendableCoins` next to it, so the sum is never the answer to "can I
 * buy this" by accident.
 */
export function countedCoins(ledger: CoinLedger): number {
  return ledger.confirmed + pendingCoins(ledger)
}

/** What may be spent: the chain's figure and nothing added to it. */
export function spendableCoins(ledger: CoinLedger): number {
  return ledger.confirmed
}

/** Confirmed-only, everywhere, always. Pending coins never make a price reachable. */
export function canAfford(ledger: CoinLedger, price: number): boolean {
  return spendableCoins(ledger) >= price
}

/** Coins short of `price`, counting only what the chain has accepted. */
export function shortfall(ledger: CoinLedger, price: number): number {
  return Math.max(0, price - spendableCoins(ledger))
}

/**
 * True when the shortfall is smaller than what is already clearing — the case
 * worth telling the player about, because the answer is "wait" rather than
 * "press more". It is deliberately not a promise: the server caps a batch that
 * arrived too fast to be a hand, so what clears can be less than what was
 * counted, and the shop says how short the row is rather than when it will not be.
 */
export function clearingCovers(ledger: CoinLedger, price: number): boolean {
  const short = shortfall(ledger, price)
  return short > 0 && pendingCoins(ledger) >= short
}

/** The line a shop row carries under its price, or nothing when it is buyable. */
export function clearingNote(ledger: CoinLedger, price: number): string | null {
  if (canAfford(ledger, price)) return null
  const short = Math.ceil(shortfall(ledger, price))
  return clearingCovers(ledger, price)
    ? `${short} short — clearing`
    : `${short} short`
}

/**
 * The sentence the shop says when it refuses a purchase before attempting it.
 *
 * It names both figures, because a player looking at a headline of 400 being
 * told they cannot afford 150 deserves to be told which 400 that was.
 */
export function cannotAffordMessage(ledger: CoinLedger, name: string, price: number): string {
  const opening = `${name} costs ${price} coins and ${Math.floor(spendableCoins(ledger))} of yours are confirmed.`
  const clearing = pendingCoins(ledger)
  return clearing > 0
    ? `${opening} Another ${Math.floor(clearing)} is still clearing — spendable once the chain accepts it.`
    : `${opening} Press the button a few more times.`
}

/**
 * The gate in front of `/game/order`, as a value rather than as control flow.
 *
 * The server checks the chain and is the authority; this refuses first so a
 * player is never sent to buy something the chain will not pay for, and so the
 * refusal names the two figures instead of arriving as a bare server error.
 * Returns the sentence to show, or null when the purchase may be attempted.
 */
export function purchaseBlock(ledger: CoinLedger, name: string, price: number): string | null {
  return canAfford(ledger, price) ? null : cannotAffordMessage(ledger, name, price)
}

// ------------------------------------------------------------------- movement
//
// One rule holds all of these together: a coin is in exactly one stage, and it
// only ever moves forward one stage at a time. Nothing adds a coin to a later
// stage without taking it out of the earlier one, so the headline never counts
// the same press twice and never blinks while a press crosses a boundary.

/** A press happened. The headline moves now, on this call, with nothing awaited. */
export function pressed(ledger: CoinLedger, coins: number): CoinLedger {
  return { ...ledger, unbanked: ledger.unbanked + coins }
}

/** The game has been asked to pay for everything counted so far. */
export function bankingStarted(ledger: CoinLedger): CoinLedger {
  return { ...ledger, unbanked: 0, banking: ledger.banking + ledger.unbanked }
}

/**
 * No proof came back, so nothing was minted and the presses are still owed.
 * They go back to where they were and the headline does not move — the player
 * pressed the button, and a failed fetch does not un-press it.
 */
export function bankingFailed(ledger: CoinLedger, coins: number): CoinLedger {
  const back = Math.min(coins, ledger.banking)
  return { ...ledger, banking: ledger.banking - back, unbanked: ledger.unbanked + back }
}

/**
 * Proof in hand: `expected` coins leave `banking` and `paid` coins enter
 * `settling`.
 *
 * These are two different numbers whenever the server capped a batch that
 * arrived too fast to be a hand (server/game.ts's bank()). The bundle carries
 * what was actually signed for, so the headline drops to the truth here — once,
 * at the moment the truth arrives, rather than silently later.
 */
export function banked(ledger: CoinLedger, expected: number, paid: number): CoinLedger {
  const cleared = Math.min(expected, ledger.banking)
  return { ...ledger, banking: ledger.banking - cleared, settling: ledger.settling + paid }
}

/**
 * Coins on their way that did not come from this browser's press counter — a mob
 * drop, or an exchange top-up. They are owed exactly like a banked press is, and
 * they are registered here so that when the chain's figure rises,
 * `reconcileConfirmed` has something to take the rise out of.
 *
 * A drop is already signed for when this is called; a top-up is not, because it
 * is registered before the payment goes out. Registering it afterwards would
 * leave a window in which the mint lands first and drains a banked press
 * instead, so the earlier call is the correct one and this stage holds both.
 */
export function claimExpected(ledger: CoinLedger, coins: number): CoinLedger {
  return { ...ledger, settling: ledger.settling + coins }
}

/**
 * The claim did not land. The coins are no longer on their way, so they leave
 * the tally — they are not put back to `unbanked`, because the game already
 * paid for those presses and pressing them again is not what happened.
 */
export function claimFailed(ledger: CoinLedger, coins: number): CoinLedger {
  return { ...ledger, settling: Math.max(0, ledger.settling - Math.min(coins, ledger.settling)) }
}

/**
 * The chain has spoken. Its figure replaces `confirmed`, and whatever it rose by
 * is taken out of `settling` in the same step.
 *
 * That single step is what stops the flicker. A claim landing is one event seen
 * twice — the wallet's summary going up, and this browser's own await coming
 * back — and draining on either one alone leaves a window where the coins are
 * counted twice or not at all. Draining by the rise means the headline is
 * unchanged across the boundary: the coins were owed, now they are owned.
 *
 * A fall is a purchase, so nothing is drained: those coins were spent, not
 * settled.
 */
export function reconcileConfirmed(ledger: CoinLedger, confirmed: number): CoinLedger {
  const gained = Math.max(0, confirmed - ledger.confirmed)
  return { ...ledger, confirmed, settling: Math.max(0, ledger.settling - gained) }
}
