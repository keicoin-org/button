/**
 * The room the button lives in.
 *
 * A player claims an address, proves control of its private key with a one-use
 * room challenge, and only then may that session press or bank. Presses arrive
 * as messages on the authenticated session, `server/presses.ts` counts them,
 * and banking spends only what was counted. Nothing is minted here — the issuer
 * does that, behind a function this room is handed and the client never names.
 *
 * Three rules make the counting worth anything:
 *
 *   The address is bound only after its signature verifies and never re-read.
 *   A press or bank message carries a count and nothing else; if it carries an
 *   address the server does not look at it, so no session can spend for a
 *   wallet whose key it does not control.
 *
 *   The registry and the issuer arrive by construction, not by option. Join and
 *   room options come off a socket, so anything reachable through them is
 *   reachable by whoever is holding it: {@link createButtonRoom} closes over the
 *   trusted pair and the room ignores every option but the address.
 *
 *   The registry outlives the room. A socket dropping is the network's opinion,
 *   not the player's — presses that were genuinely observed are still owed when
 *   they come back, so leaving forgets the session and not the address.
 */

import { Room, ServerError, type Client } from '@colyseus/core'
import { isAddress, type ClaimBundle } from 'kei-transaction'

import {
  AUTH_CHALLENGE,
  AUTH_PROOF,
  AUTH_RESULT,
  createOwnershipChallenge,
  ownershipChallengeMessage,
  secureChallengeTokens,
  verifyOwnershipProof,
  type AuthenticationResult,
  type ChallengeTokenFactory,
  type OwnershipChallenge,
} from './auth.js'
import { PressRegistry } from './presses.js'

/** Colyseus' own codes stop at 4000; this is a bad join, not a transport fault. */
const INVALID_ADDRESS = 4000
/** Private application close code for a session that never authenticated. */
const AUTHENTICATION_FAILED = 4001

export const DEFAULT_AUTHENTICATION_DEADLINE_MS = 10_000
const MAX_AUTHENTICATION_DEADLINE_MS = 60_000

/** Bank requests and their answers share one message type, correlated by id. */
export const BANK = 'bank'

/** Whatever the client used to tell its own requests apart. Echoed, never read. */
export type RequestId = string | number | null

/**
 * All this room ever asks of a client: who it is, and somewhere to answer.
 *
 * Colyseus' `Client` satisfies it, so production keeps its own types; a test
 * satisfies it with an object literal and a push, so nothing needs a socket.
 */
export interface ResponseClient {
  sessionId: string
  send(type: string, message?: unknown): void
}

/** Authentication must be able to close a socket that has no usable identity. */
export interface AuthenticationClient extends ResponseClient {
  leave(code?: number, data?: string): void
}

export interface BankAccepted {
  ok: true
  id: RequestId
  /** What the server saw and spent, which is not necessarily what was asked for. */
  presses: number
  claim: ClaimBundle
}

export interface BankRefused {
  ok: false
  id: RequestId
  error: string
}

export type BankResult = BankAccepted | BankRefused

/** The issuer's payout, as `server/game.ts` exposes it. */
export type BankPresses = (address: string, presses: number) => Promise<ClaimBundle>

/** Return a cancellation function for one room-owned deadline. */
export type ScheduleAuthenticationDeadline = (expires: () => void, afterMs: number) => () => void

export interface ButtonRoomDependencies {
  /** Trusted: called with the count the server observed, never a client's. */
  bank: BankPresses
  /** Trusted, and shared with anything else that spends presses. */
  registry?: PressRegistry
  /** Trusted construction seam for deterministic tests, never socket input. */
  challengeTokens?: ChallengeTokenFactory
  /** Trusted deadline policy; socket/room options cannot replace it. */
  authenticationDeadlineMs?: number
  /** Trusted scheduler seam for deterministic tests. */
  scheduleAuthenticationDeadline?: ScheduleAuthenticationDeadline
}

export interface JoinOptions {
  address?: unknown
}

/**
 * Presses survive their room. Rooms are created and disposed by the matchmaker
 * as players come and go; the presses they observed are owed until banked, so
 * they are held one level up unless a composer passes its own registry in.
 */
export const observedPresses = new PressRegistry()

interface AuthenticationAttempt {
  challenge: OwnershipChallenge
  cancelDeadline(): void
}

/**
 * Build the room class, bound to the issuer and registry it is allowed to use.
 *
 * The class is made per composition rather than exported directly so there is no
 * moment at which the dependencies are settable — by the time a socket exists,
 * they are already closed over and there is no seam left to pass them through.
 */
export function createButtonRoom(dependencies: ButtonRoomDependencies) {
  const { bank: bankPresses } = dependencies
  const presses = dependencies.registry ?? observedPresses
  const nextTokens = dependencies.challengeTokens ?? secureChallengeTokens
  const authenticationDeadlineMs = dependencies.authenticationDeadlineMs ?? DEFAULT_AUTHENTICATION_DEADLINE_MS
  if (
    !Number.isSafeInteger(authenticationDeadlineMs) ||
    authenticationDeadlineMs < 1 ||
    authenticationDeadlineMs > MAX_AUTHENTICATION_DEADLINE_MS
  ) {
    throw new Error(`The authentication deadline must be a whole number from 1 to ${MAX_AUTHENTICATION_DEADLINE_MS}ms.`)
  }
  const scheduleAuthenticationDeadline =
    dependencies.scheduleAuthenticationDeadline ?? scheduleSystemDeadline

  return class ButtonRoom extends Room {
    /** Claimed identities waiting for a signature; never used for game state. */
    private readonly pending = new Map<string, AuthenticationAttempt>()

    /** In-flight proofs, so leaving or a duplicate cannot race authorization. */
    private readonly authenticating = new Map<string, AuthenticationAttempt>()

    /** Authenticated session to address. The only map game actions may read. */
    private readonly joined = new Map<string, string>()

    /** Room options come from `create`, which the client can call. None are read. */
    override onCreate(): void {
      this.onMessage(BANK, (client: Client, message: unknown) => {
        void this.bank(client, message)
      })
      this.onMessage('press', (client: Client, message: unknown) => {
        this.press(client, message)
      })
      this.onMessage(AUTH_PROOF, (client: Client, message: unknown) => {
        void this.authenticate(client, message)
      })
    }

    override onJoin(client: Client, options?: JoinOptions): void {
      const address = options?.address
      if (!isAddress(address)) throw new ServerError(INVALID_ADDRESS, 'Join with a kei address.')
      if (this.pending.has(client.sessionId) || this.authenticating.has(client.sessionId) || this.joined.has(client.sessionId)) {
        throw new ServerError(INVALID_ADDRESS, 'That room session is already joined.')
      }

      const challenge = createOwnershipChallenge(
        { address, roomId: this.roomId, sessionId: client.sessionId },
        nextTokens(),
      )
      const attempt: AuthenticationAttempt = { challenge, cancelDeadline: () => undefined }
      this.pending.set(client.sessionId, attempt)

      const cancelDeadline = scheduleAuthenticationDeadline(
        () => this.expireAuthentication(client, attempt),
        authenticationDeadlineMs,
      )
      attempt.cancelDeadline = once(cancelDeadline)

      // A deterministic test scheduler is allowed to expire synchronously.
      if (this.pending.get(client.sessionId) !== attempt) {
        attempt.cancelDeadline()
        return
      }
      try {
        client.send(AUTH_CHALLENGE, ownershipChallengeMessage(challenge))
      } catch (error) {
        this.pending.delete(client.sessionId)
        attempt.cancelDeadline()
        throw error
      }
    }

    /**
     * Consume and verify the one-use proof before making the session playable.
     *
     * The pending challenge is deleted before the first await. A concurrent
     * duplicate therefore has nothing to verify, while leaving deletes the
     * attempt marker and prevents a late verifier from resurrecting a socket.
     */
    async authenticate(client: AuthenticationClient, message: unknown): Promise<AuthenticationResult> {
      const attempt = this.pending.get(client.sessionId)
      if (attempt === undefined) {
        // A proof replay by an already authorized socket is refused without
        // tearing down the valid session. Every unauthenticated duplicate is
        // terminal and also cancels any verifier it raced.
        if (this.joined.has(client.sessionId)) return this.answerAuth(client, authenticationFailed())
        const verifying = this.authenticating.get(client.sessionId)
        if (verifying) {
          this.authenticating.delete(client.sessionId)
          verifying.cancelDeadline()
        }
        return this.refuseAuthentication(client)
      }

      this.pending.delete(client.sessionId)
      this.authenticating.set(client.sessionId, attempt)
      const verified = await verifyOwnershipProof(attempt.challenge, message)

      if (this.authenticating.get(client.sessionId) !== attempt) return authenticationFailed()
      this.authenticating.delete(client.sessionId)
      attempt.cancelDeadline()
      if (!verified) return this.refuseAuthentication(client)

      this.joined.set(client.sessionId, attempt.challenge.address)
      return this.answerAuth(client, { ok: true })
    }

    /**
     * Record a press burst against whoever this session joined as. Returns what
     * was counted, which is zero for a session that never joined and for a count
     * that is not a positive whole number.
     */
    press(client: ResponseClient, message: unknown): number {
      const address = this.joined.get(client.sessionId)
      if (address === undefined) return 0
      return presses.observe(address, countIn(message))
    }

    /**
     * Spend observed presses and answer with the claim they bought.
     *
     * Returns the same result it sends, so a test can await the decision instead
     * of the socket. The client asks for a number; it is given the smaller of
     * that and what the server saw, and the issuer is told that second number.
     */
    async bank(client: ResponseClient, message: unknown): Promise<BankResult> {
      const id = requestIdIn(message)
      const address = this.joined.get(client.sessionId)
      if (address === undefined) {
        return this.answer(client, { ok: false, id, error: 'Authenticate your Kei wallet before banking.' })
      }

      const requested = countIn(message)
      if (typeof requested !== 'number' || !Number.isInteger(requested) || requested <= 0) {
        return this.answer(client, { ok: false, id, error: 'Bank a positive whole number of presses.' })
      }

      // Taken before anything is awaited, so two banks in flight for the same
      // address divide the tally between them and cannot both be sold the same
      // press. Whichever loses the race finds nothing left and is refused.
      const observed = presses.consume(address, requested)
      if (observed <= 0) return this.answer(client, { ok: false, id, error: 'The server saw no presses to bank.' })

      let claim: ClaimBundle
      try {
        claim = await bankPresses(address, observed)
      } catch {
        // Only the payout is guarded, and it restores exactly what was taken, so
        // a failed payout costs the player nothing and earns them nothing. The
        // issuer's reason is not forwarded: it is written for a log, and this
        // message goes to whoever asked.
        presses.restore(address, observed)
        return this.answer(client, { ok: false, id, error: 'Banking failed. Your presses are still yours.' })
      }

      // Past the rollback on purpose. The claim exists now, so a socket that
      // cannot be written to loses the answer and not the presses that paid for
      // it — restoring here would sell them a second time.
      return this.answer(client, { ok: true, id, presses: observed, claim })
    }

    override onLeave(client: Client): void {
      // Every local form of the session is gone; the presses are not. Banking
      // is the only thing that spends them, and a player who reloads mid-burst
      // is still owed them after proving the wallet again.
      this.pending.get(client.sessionId)?.cancelDeadline()
      this.authenticating.get(client.sessionId)?.cancelDeadline()
      this.pending.delete(client.sessionId)
      this.authenticating.delete(client.sessionId)
      this.joined.delete(client.sessionId)
    }

    private answer(client: ResponseClient, result: BankResult): BankResult {
      client.send(BANK, result)
      return result
    }

    private answerAuth(client: ResponseClient, result: AuthenticationResult): AuthenticationResult {
      client.send(AUTH_RESULT, result)
      return result
    }

    private expireAuthentication(client: AuthenticationClient, attempt: AuthenticationAttempt): void {
      if (this.pending.get(client.sessionId) === attempt) this.pending.delete(client.sessionId)
      else if (this.authenticating.get(client.sessionId) === attempt) this.authenticating.delete(client.sessionId)
      else return

      attempt.cancelDeadline()
      this.refuseAuthentication(client)
    }

    private refuseAuthentication(client: AuthenticationClient): AuthenticationResult {
      const result = authenticationFailed()
      try {
        client.send(AUTH_RESULT, result)
      } catch {
        // The close below is the security action; a dead response channel does
        // not make an unauthenticated socket worth retaining.
      }
      try {
        client.leave(AUTHENTICATION_FAILED, 'Wallet authentication failed.')
      } catch {
        // Colyseus will still run onLeave when the broken transport disappears.
      }
      return result
    }
  }
}

export type ButtonRoom = InstanceType<ReturnType<typeof createButtonRoom>>

/**
 * The count in a message, and only the count.
 *
 * Bare numbers and `{ presses }` both read, because the client has no reason to
 * wrap a press and every reason to be allowed to grow the message later.
 * Anything else in the object — an address, most of all — is not read here and
 * cannot be.
 */
function countIn(message: unknown): unknown {
  if (typeof message === 'number') return message
  if (typeof message === 'object' && message !== null) return (message as { presses?: unknown }).presses
  return undefined
}

/** The client's own label for this request. Never trusted, only handed back. */
function requestIdIn(message: unknown): RequestId {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null
  const descriptor = Object.getOwnPropertyDescriptor(message, 'id')
  if (!descriptor || !('value' in descriptor)) return null
  const id = descriptor.value
  if (typeof id === 'string') return id.length <= 64 ? id : null
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : null
}

/** One public failure for absent, malformed, replayed, and invalid proofs. */
function authenticationFailed(): AuthenticationResult {
  return { ok: false, error: 'Wallet ownership could not be verified. Reconnect to try again.' }
}

function scheduleSystemDeadline(expires: () => void, afterMs: number): () => void {
  const timer = setTimeout(expires, afterMs)
  return () => clearTimeout(timer)
}

function once(cancel: () => void): () => void {
  let active = true
  return () => {
    if (!active) return
    active = false
    cancel()
  }
}
