/**
 * Who is asking, and what this server actually saw them do.
 *
 * Before this file, `/game/bank` took an address and a press count out of a
 * request body and paid for both. Nothing proved the caller held the key to the
 * address, and nothing but the caller's own arithmetic said the presses had
 * happened. This is the boundary that closes both, and it is deliberately two
 * separate things stacked in this order:
 *
 *   1. **Authentication** — a one-use, expiring, domain-separated challenge the
 *      wallet signs. It answers *who*, and nothing else.
 *   2. **Observation** — a counter this server increments, one press per
 *      request that reached it, under a ceiling. It answers *what*, and the
 *      caller never gets to state it.
 *
 * Keeping them apart is the point. A proof of wallet control is not a receipt
 * for work, and a tally of observed presses is not a permission to be paid for
 * somebody else's.
 *
 * What is *not* here: any notion of settlement. This file never mints, never
 * commits, and holds no balances. It hands `server/game.ts` a number and an
 * address, and the chain remains the only place either becomes money.
 */

import {
  OwnershipError,
  ownershipChallengeHash,
  randomChallengeNonce,
  verifyOwnershipProof,
  type NonceStore,
  type OwnershipChallengeMessage,
} from '../shared/ownership.js'
import { GameError } from './errors.js'

/** Button's own namespace. Bump the version and every outstanding proof retires. */
export const SESSION_DOMAIN = 'keicoin.org/button/session/v1'

/** A challenge nobody redeemed is not a challenge anybody may still redeem. */
export const CHALLENGE_TTL_MS = 60_000
/** A session goes quiet for this long and it is gone. Reconnecting is cheap. */
export const SESSION_TTL_MS = 30 * 60_000

/** Hits a slime takes before this server will say it died. */
export const HITS_PER_MOB = 3

/**
 * The observation ceiling, and why it is a bucket rather than a window.
 *
 * `capacity` is the most this server will ever have unspent for one address, and
 * it is reached after `capacity / refillPerSecond` seconds of quiet and never
 * exceeded however much longer the quiet lasts. That is the whole difference
 * from the ceiling this replaces, which computed an allowance from time elapsed
 * since the last request with no upper bound — an hour of idling bought 90,000
 * presses, and a day bought two million (create-kei-game#42).
 *
 * It is keyed by **address**, not by session, so a new session, a reconnect, or
 * twenty sockets at once all draw down the same bucket.
 */
export interface CeilingOptions {
  /** Observations restored per second. */
  refillPerSecond?: number
  /** The largest burst a rested address can spend at once. */
  capacity?: number
}

/** Fast for a finger, slow for a script. */
export const DEFAULT_OBSERVATION_RATE = 25
/** Seconds of headroom a rested address gets, so real clicking is not punished. */
export const OBSERVATION_BURST_SECONDS = 2

export interface SessionOptions extends CeilingOptions {
  /** Distinguishes this running instance from every other. Signed into the challenge. */
  room: string
  challengeTtlMs?: number
  sessionTtlMs?: number
  /** Live sessions kept. The oldest is dropped past this, and re-proving is cheap. */
  maxSessions?: number
  /** Outstanding challenges kept. Past this the oldest is refused, never re-admitted. */
  maxChallenges?: number
  now?: () => number
}

export interface Session {
  id: string
  address: string
  origin: string
}

export interface PressReceipt {
  /** Presses this server has seen for this session and not yet paid out. */
  observed: number
  /** Observations still available to this address right now. */
  remaining: number
}

export interface HitReceipt {
  mob: string
  hits: number
  needed: number
  /** Set once the server has watched the mob die. One use, at `/game/loot`. */
  event?: string
}

export class SessionError extends GameError {}

interface PendingChallenge {
  address: string
  origin: string
  issuedAt: number
}

interface LiveSession {
  id: string
  address: string
  origin: string
  touchedAt: number
  /** Presses observed and not yet banked. Spent by `take`, restored on failure. */
  observed: number
  /** Hits landed on each mob that is not dead yet. */
  fights: Map<string, number>
}

interface LootEvent {
  session: string
  address: string
  mob: string
  at: number
}

interface Bucket {
  tokens: number
  at: number
}

export interface SessionRegistry {
  /** What a client signs. One use, expiring, and bound to this room and origin. */
  challenge(address: string, origin: string): OwnershipChallengeMessage
  /** Redeem a signed challenge for a session id. Throws on anything that is not one. */
  authenticate(proof: unknown, origin: string): Promise<Session>
  /** The session behind an id, or a sentence saying why there is not one. */
  require(id: unknown, origin: string): Session
  /** One press, observed by this server because this request reached it. */
  press(id: unknown, origin: string): PressReceipt
  /** One hit on a mob. The kill is this server's to declare, not the caller's. */
  hit(id: unknown, origin: string, mob: unknown): HitReceipt
  /** Take the observed tally, leaving zero. Synchronous, so two banks divide it. */
  take(id: unknown, origin: string): { session: Session; presses: number }
  /** Put back exactly what `take` removed, when the payout never happened. */
  restore(id: string, presses: number): void
  /** Redeem a kill this server recorded. One use; the mob id is never the caller's. */
  redeem(id: unknown, origin: string, event: unknown): { session: Session; mob: string }
  /** Undo `redeem` when the payout failed, so an honest kill is not eaten. */
  unredeem(event: string, entry: { session: string; address: string; mob: string }): void
  readonly room: string
}

export function createSessions(options: SessionOptions): SessionRegistry {
  const now = options.now ?? Date.now
  const room = options.room
  const challengeTtl = options.challengeTtlMs ?? CHALLENGE_TTL_MS
  const sessionTtl = options.sessionTtlMs ?? SESSION_TTL_MS
  const maxSessions = options.maxSessions ?? 4_096
  const maxChallenges = options.maxChallenges ?? 4_096
  const refill = options.refillPerSecond ?? DEFAULT_OBSERVATION_RATE
  const capacity = options.capacity ?? refill * OBSERVATION_BURST_SECONDS

  const pending = new Map<string, PendingChallenge>()
  const sessions = new Map<string, LiveSession>()
  const buckets = new Map<string, Bucket>()
  const events = new Map<string, LootEvent>()
  /** Which mobs an address has already been paid for. Survives every new session. */
  const looted = new Set<string>()

  /**
   * The nonce store the verifier consumes through.
   *
   * Forgetting a nonce here only ever *refuses* it — a nonce is usable once, and
   * an evicted or expired one is turned away rather than re-admitted. That is
   * what makes bounding this map safe.
   */
  const nonces: NonceStore = {
    use(nonce) {
      const entry = pending.get(nonce)
      if (!entry) return false
      pending.delete(nonce)
      return now() - entry.issuedAt <= challengeTtl
    },
  }

  function sweep(): void {
    const at = now()
    for (const [nonce, entry] of pending) {
      if (at - entry.issuedAt > challengeTtl) pending.delete(nonce)
    }
    for (const [id, session] of sessions) {
      if (at - session.touchedAt > sessionTtl) sessions.delete(id)
    }
    for (const [address, bucket] of buckets) {
      // Only a *full* bucket is forgettable, and forgetting one is not a reset:
      // a bucket that is recreated starts full, which is the state it was in.
      // A partly spent bucket is the record of a spend and is never dropped.
      if (bucket.tokens >= capacity && at - bucket.at > sessionTtl) buckets.delete(address)
    }
    for (const [id, event] of events) {
      if (at - event.at > sessionTtl) events.delete(id)
    }
  }

  /** Synchronous check-and-spend. Nothing awaits between reading and writing it. */
  function spend(address: string): number {
    const at = now()
    const bucket = buckets.get(address) ?? { tokens: capacity, at }
    const restored = ((at - bucket.at) / 1_000) * refill
    // Clamped at capacity on the way in, which is the line create-kei-game#42 is
    // missing. Idling buys back headroom; it never banks more than one burst.
    bucket.tokens = Math.min(capacity, bucket.tokens + restored)
    bucket.at = at

    if (bucket.tokens < 1) {
      buckets.set(address, bucket)
      throw new SessionError(
        `That is faster than ${refill} presses a second. Wait a moment and press again.`,
      )
    }
    bucket.tokens -= 1
    buckets.set(address, bucket)
    return Math.floor(bucket.tokens)
  }

  function touch(id: unknown, origin: string): LiveSession {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      throw new SessionError('That request carried no session. Prove your address first.')
    }
    const session = sessions.get(id)
    if (!session) {
      throw new SessionError('That session is not open here. Prove your address again.')
    }
    if (now() - session.touchedAt > sessionTtl) {
      sessions.delete(id)
      throw new SessionError('That session went quiet for too long. Prove your address again.')
    }
    // The origin is bound at the challenge and re-checked on every use, so a
    // session id that leaks to another page is not a session there.
    if (session.origin !== origin) {
      throw new SessionError('That session belongs to a different origin.')
    }
    session.touchedAt = now()
    return session
  }

  const bare = (session: LiveSession): Session => ({
    id: session.id,
    address: session.address,
    origin: session.origin,
  })

  return {
    room,

    challenge(address, origin) {
      sweep()
      if (typeof address !== 'string' || address.length === 0 || address.length > 128) {
        throw new SessionError('Ask for a challenge with the address you are proving.')
      }
      if (pending.size >= maxChallenges) {
        throw new SessionError('Too many challenges are outstanding here. Try again in a moment.')
      }

      const nonce = randomChallengeNonce()
      pending.set(nonce, { address, origin, issuedAt: now() })

      const challenge: OwnershipChallengeMessage = {
        domain: SESSION_DOMAIN,
        address,
        nonce,
        // Signed, and re-checked on redemption: a proof made against one running
        // issuer, from one page, authenticates nowhere else.
        context: { room, origin },
      }
      // A courtesy, so the wallet can say the server disagreed rather than
      // silently signing something else. The wallet derives its own and refuses
      // a mismatch, which is what keeps this from being a signing oracle.
      return { ...challenge, hash: ownershipChallengeHash(challenge) }
    },

    async authenticate(proof, origin) {
      sweep()

      // The nonce names which challenge this claims to answer, and the address
      // and origin come from *that record* rather than from the proof — so a
      // proof cannot nominate the expectation it is checked against.
      const nonce = nonceIn(proof)
      const issued = nonce === null ? undefined : pending.get(nonce)
      if (nonce === null || !issued) {
        throw new SessionError('That challenge was never issued here, or it has already been used.')
      }

      let verified: boolean
      try {
        verified = await verifyOwnershipProof(proof, {
          domain: SESSION_DOMAIN,
          address: issued.address,
          nonce,
          context: { room, origin: issued.origin },
          nonces,
        })
      } catch (error) {
        // Only a malformed expectation reaches here, which would be this
        // server's own bug — but the caller gets a sentence rather than a stack.
        throw new SessionError(error instanceof OwnershipError ? error.message : 'That proof could not be checked.')
      }

      if (!verified) {
        throw new SessionError('That signature does not prove control of this address.')
      }
      if (issued.origin !== origin) {
        throw new SessionError('That challenge was issued for a different origin.')
      }

      if (sessions.size >= maxSessions) {
        const oldest = sessions.keys().next()
        if (!oldest.done) sessions.delete(oldest.value)
      }

      const id = randomChallengeNonce()
      sessions.set(id, {
        id,
        address: issued.address,
        origin,
        touchedAt: now(),
        observed: 0,
        fights: new Map(),
      })
      return { id, address: issued.address, origin }
    },

    require(id, origin) {
      return bare(touch(id, origin))
    },

    press(id, origin) {
      const session = touch(id, origin)
      const remaining = spend(session.address)
      session.observed += 1
      return { observed: session.observed, remaining }
    },

    hit(id, origin, mob) {
      const session = touch(id, origin)
      if (typeof mob !== 'string' || !/^slime-[1-3]$/.test(mob)) {
        throw new SessionError('That mob does not exist.')
      }
      if (looted.has(`${session.address}:${mob}`)) {
        throw new SessionError('That mob is already dead and its drop already claimed.')
      }

      // A hit is an observation and comes out of the same bucket a press does,
      // so a script cannot spend its ceiling on mobs instead.
      spend(session.address)

      const hits = (session.fights.get(mob) ?? 0) + 1
      if (hits < HITS_PER_MOB) {
        session.fights.set(mob, hits)
        return { mob, hits, needed: HITS_PER_MOB }
      }

      session.fights.delete(mob)
      const event = randomChallengeNonce()
      events.set(event, { session: session.id, address: session.address, mob, at: now() })
      return { mob, hits: HITS_PER_MOB, needed: HITS_PER_MOB, event }
    },

    take(id, origin) {
      const session = touch(id, origin)
      // Read and cleared in one synchronous step, before the caller awaits
      // anything. Two banks in flight therefore divide the tally instead of
      // both selling it.
      const presses = session.observed
      session.observed = 0
      if (presses <= 0) {
        throw new SessionError('This server has not seen any presses from you yet.')
      }
      return { session: bare(session), presses }
    },

    restore(id, presses) {
      const session = sessions.get(id)
      if (session) session.observed += presses
    },

    redeem(id, origin, event) {
      const session = touch(id, origin)
      if (typeof event !== 'string' || event.length === 0 || event.length > 128) {
        throw new SessionError('A drop is claimed with the event id the kill returned.')
      }
      const record = events.get(event)
      if (!record) {
        throw new SessionError('That kill was not recorded here, or its drop is already claimed.')
      }
      if (record.session !== session.id) {
        throw new SessionError('That kill belongs to a different session.')
      }
      // Deleted before the payout is awaited, so two redemptions of one kill
      // cannot both reach the issuer.
      events.delete(event)
      looted.add(`${record.address}:${record.mob}`)
      return { session: bare(session), mob: record.mob }
    },

    unredeem(event, entry) {
      looted.delete(`${entry.address}:${entry.mob}`)
      events.set(event, { ...entry, at: now() })
    },
  }
}

/** The nonce out of an untrusted proof, without trusting anything else in it. */
function nonceIn(proof: unknown): string | null {
  if (typeof proof !== 'object' || proof === null) return null
  const challenge = (proof as { challenge?: unknown }).challenge
  if (typeof challenge !== 'object' || challenge === null) return null
  const nonce = (challenge as { nonce?: unknown }).nonce
  return typeof nonce === 'string' && nonce.length > 0 && nonce.length <= 128 ? nonce : null
}
