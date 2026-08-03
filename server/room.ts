/**
 * The room the button lives in.
 *
 * A player joins with the address their browser already owns, presses arrive as
 * messages on that session, `server/presses.ts` counts them, and banking spends
 * only what was counted. Nothing is minted here — the issuer does that, behind a
 * function this room is handed and the client never names.
 *
 * Three rules make the counting worth anything:
 *
 *   The address is bound at join and never re-read. A press or bank message
 *   carries a count and nothing else; if it carries an address the server does
 *   not look at it, so no session can spend for a wallet that is not its own.
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

import { PressRegistry } from './presses.js'

/** Colyseus' own codes stop at 4000; this is a bad join, not a transport fault. */
const INVALID_ADDRESS = 4000

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

export interface ButtonRoomDependencies {
  /** Trusted: called with the count the server observed, never a client's. */
  bank: BankPresses
  /** Trusted, and shared with anything else that spends presses. */
  registry?: PressRegistry
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

  return class ButtonRoom extends Room {
    /** Session to address. The only place a session's identity is decided. */
    private readonly joined = new Map<string, string>()

    /** Room options come from `create`, which the client can call. None are read. */
    override onCreate(): void {
      this.onMessage(BANK, (client: Client, message: unknown) => {
        void this.bank(client, message)
      })
      this.onMessage('press', (client: Client, message: unknown) => {
        this.press(client, message)
      })
    }

    override onJoin(client: Client, options?: JoinOptions): void {
      const address = options?.address
      if (!isAddress(address)) throw new ServerError(INVALID_ADDRESS, 'Join with a kei address.')
      this.joined.set(client.sessionId, address)
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
      if (address === undefined) return this.answer(client, { ok: false, id, error: 'Join before banking.' })

      const requested = countIn(message)
      if (typeof requested !== 'number' || !Number.isInteger(requested) || requested <= 0) {
        return this.answer(client, { ok: false, id, error: 'Bank a positive whole number of presses.' })
      }

      // Taken before anything is awaited, so two banks in flight for the same
      // address divide the tally between them and cannot both be sold the same
      // press. Whichever loses the race finds nothing left and is refused.
      const observed = presses.consume(address, requested)
      if (observed <= 0) return this.answer(client, { ok: false, id, error: 'The server saw no presses to bank.' })

      try {
        const claim = await bankPresses(address, observed)
        return this.answer(client, { ok: true, id, presses: observed, claim })
      } catch {
        // Exactly what was taken, so a failed payout costs the player nothing and
        // earns them nothing. The issuer's reason is not forwarded: it is written
        // for a log, and this message goes to whoever asked.
        presses.restore(address, observed)
        return this.answer(client, { ok: false, id, error: 'Banking failed. Your presses are still yours.' })
      }
    }

    override onLeave(client: Client): void {
      // The session is gone; the presses are not. Banking is the only thing that
      // spends them, and a player who reloads mid-burst is still owed them.
      this.joined.delete(client.sessionId)
    }

    private answer(client: ResponseClient, result: BankResult): BankResult {
      client.send(BANK, result)
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
  if (typeof message !== 'object' || message === null) return null
  const id = (message as { id?: unknown }).id
  return typeof id === 'string' || typeof id === 'number' ? id : null
}
