/**
 * What the server saw.
 *
 * Until now the client counted its own presses and the issuer trusted the number
 * with a rate ceiling over it (`server/game.ts`). That ceiling bounds the theft;
 * it does not stop it. This registry is the other half: presses arrive as
 * messages on a socket the server owns, are counted here, and banking may spend
 * only what was counted. A press nobody sent is worth nothing, not "a few coins".
 *
 * It is deliberately not a ledger. It holds one small integer per address, it
 * forgets it the moment it is spent, and it never mints anything — the chain is
 * still the only place a balance exists.
 */

// The checksum, not the prefix. `kei_` on the front of a typo is still a typo,
// and a tally kept under one would be owed to an account that cannot claim it.
import { isAddress } from 'kei-transaction'

/**
 * The most presses one message may be worth.
 *
 * Clients batch presses inside a frame rather than opening a socket write per
 * finger tap, so a message is a burst and not a session total. Ten is above any
 * plausible burst from a hand and far below anything worth forging: a client
 * that claims more has the excess dropped, silently, because the honest client
 * never reaches it.
 */
export const MAX_PRESSES_PER_MESSAGE = 10

/** A positive whole number of presses — not a float, not Infinity, not a lie. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export class PressRegistry {
  private readonly observed = new Map<string, number>()

  /**
   * Count presses seen on a joined session. Returns what was actually recorded,
   * which is zero for a malformed count and at most {@link MAX_PRESSES_PER_MESSAGE}.
   */
  observe(address: string, count: unknown): number {
    if (!isAddress(address) || !isCount(count)) return 0
    const recorded = Math.min(count, MAX_PRESSES_PER_MESSAGE)
    this.observed.set(address, (this.observed.get(address) ?? 0) + recorded)
    return recorded
  }

  /** How many presses this address has to its name and has not banked yet. */
  pending(address: string): number {
    return this.observed.get(address) ?? 0
  }

  /**
   * Take up to `requested` presses, once.
   *
   * The caller asks for what the client thinks it earned and is given what the
   * server saw, whichever is smaller. Whatever is handed out is gone from here
   * before this returns, so a retry of the same bank cannot spend it twice; a
   * partial take leaves the remainder for the next one.
   */
  consume(address: string, requested: unknown): number {
    if (!isAddress(address) || !isCount(requested)) return 0
    const available = this.observed.get(address) ?? 0
    const taken = Math.min(available, requested)
    if (taken <= 0) return 0
    if (taken === available) this.observed.delete(address)
    else this.observed.set(address, available - taken)
    return taken
  }

  /**
   * Put back presses a {@link consume} took and could not pay for.
   *
   * Only the caller that consumed them may call this, with exactly the number it
   * was given: the per-message cap does not apply, because these are presses the
   * server already counted once and is handing back, not new ones being claimed.
   */
  restore(address: string, count: unknown): void {
    if (!isAddress(address) || !isCount(count)) return
    this.observed.set(address, (this.observed.get(address) ?? 0) + count)
  }

  /**
   * Drop an address entirely. Only for a player who has left for good and whose
   * presses will never be banked — a disconnect is not that (see `server/room.ts`).
   */
  forget(address: string): void {
    this.observed.delete(address)
  }
}
