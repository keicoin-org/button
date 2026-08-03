/**
 * The browser's end of the observed-press room.
 *
 * The shape worth noticing is that this file never sends an address. It sends
 * one at join time, as a claim, and the room treats it as a claim: nothing is
 * counted for that wallet until the signature comes back. After that the
 * session *is* the identity, so a press is a number and a bank is a number, and
 * there is no field in either that could name somebody else.
 *
 * It also never falls back. If the room is up, the room is the only way to
 * bank; `src/economy.ts` closes the HTTP path for the whole session rather than
 * retrying a bank over it, because a client that quietly downgrades when
 * authentication is inconvenient has no authentication.
 */

import { Client, type Room } from 'colyseus.js'
import type { ClaimBundle } from 'kei-transaction'

import {
  AUTH_CHALLENGE,
  AUTH_PROOF,
  AUTH_RESULT,
  type AuthenticationResult,
} from '../shared/session-auth.js'
import type { OwnershipSigner } from './ownership.js'

/** Matches `MAX_PRESSES_PER_MESSAGE` in `server/presses.ts`. */
const PRESSES_PER_MESSAGE = 10

/** Long enough for a signature on a slow phone, short enough to not hang a game. */
const JOIN_TIMEOUT_MS = 15_000
const BANK_TIMEOUT_MS = 20_000

const BANK = 'bank'
const PRESS = 'press'

interface BankAccepted {
  ok: true
  id: string
  presses: number
  claim: ClaimBundle
}

interface BankRefused {
  ok: false
  id: string
  error: string
}

type BankResult = BankAccepted | BankRefused

export interface ArenaSession {
  /** The address this session proved. Always the signer's own. */
  readonly address: string
  /** Tell the room about presses that already happened. Fire and forget. */
  press(times: number): void
  /**
   * Spend up to `presses` of what the room saw, and hand back the proof.
   *
   * Rejects with a sentence when the room refuses, when it never answers, or
   * when the socket dies mid-request. It never resolves with a partial success:
   * `claim` is the entitlement and `presses` is what was actually spent for it,
   * which may be fewer than were asked for.
   */
  bank(presses: number): Promise<{ presses: number; claim: ClaimBundle }>
  close(): void
}

export interface JoinArenaOptions {
  url: string
  room: string
  signer: OwnershipSigner
  /** Called when the room drops the session, so the game can stop pretending. */
  onClosed?: (reason: string) => void
}

/**
 * Join, prove the wallet, and hand back a session that can press and bank.
 *
 * Rejects unless the room said `ok`. There is deliberately no "joined but
 * unauthenticated" state to hold: every operation on the returned session needs
 * the proof, so a session that has not proved is not one.
 */
export async function joinArena(options: JoinArenaOptions): Promise<ArenaSession> {
  const client = new Client(options.url)
  const room: Room = await client.joinOrCreate(options.room, { address: options.signer.address })

  try {
    await prove(room, options.signer)
  } catch (error) {
    // Not consented: this is a session that failed to prove itself, and the
    // room has almost certainly closed the socket already.
    void room.leave(false).catch(() => undefined)
    throw error
  }

  const waiting = new Map<string, { settle(result: BankResult): void; fail(error: Error): void }>()
  let sequence = 0
  let closedBecause: string | null = null

  /**
   * End the session, once.
   *
   * `notify` is false when the caller is the one closing it: a game shutting
   * down does not need to be told by itself that it shut down, and telling it
   * would put a disconnection notice on the screen on the way out.
   */
  const abandon = (reason: string, notify = true): void => {
    if (closedBecause !== null) return
    closedBecause = reason
    for (const pending of waiting.values()) pending.fail(new Error(reason))
    waiting.clear()
    if (notify) options.onClosed?.(reason)
  }

  room.onMessage(BANK, (message: BankResult) => {
    // The id is this client's own label, echoed. An answer to a request this
    // client never made has nowhere to go, and is dropped rather than guessed at.
    const id: unknown = message?.id
    if (typeof id === 'string') waiting.get(id)?.settle(message)
  })
  room.onLeave(() => abandon('The button room disconnected. Presses are counted again once it is back.'))
  room.onError((_code, message) => abandon(message ?? 'The button room reported an error.'))

  return {
    address: options.signer.address,

    press(times: number) {
      if (closedBecause !== null || !Number.isInteger(times) || times <= 0) return
      // Split into bursts the room will accept whole. Anything above the cap is
      // dropped there rather than clamped, so sending 30 as one message would
      // quietly become 10 and the player would be owed the rest by nobody.
      for (let sent = 0; sent < times; sent += PRESSES_PER_MESSAGE) {
        room.send(PRESS, { presses: Math.min(PRESSES_PER_MESSAGE, times - sent) })
      }
    },

    async bank(presses: number) {
      if (closedBecause !== null) throw new Error(closedBecause)

      sequence += 1
      const id = `bank-${sequence}`
      const result = await new Promise<BankResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(new Error('The button room did not answer in time. Your presses are still yours.'))
        }, BANK_TIMEOUT_MS)

        waiting.set(id, {
          settle(answer) {
            clearTimeout(timer)
            waiting.delete(id)
            resolve(answer)
          },
          fail(error) {
            clearTimeout(timer)
            reject(error)
          },
        })

        room.send(BANK, { id, presses })
      })

      if (!result.ok) throw new Error(result.error)
      return { presses: result.presses, claim: result.claim }
    },

    close() {
      abandon('This session left the button room.', false)
      void room.leave(true).catch(() => undefined)
    },
  }
}

/**
 * One challenge, one signature, one verdict.
 *
 * The room sends the challenge unprompted on join and closes the socket if it
 * goes unanswered, so this waits for it rather than asking. The signer is what
 * decides whether the challenge is signable at all — this function only carries
 * bytes and never inspects them.
 */
function prove(room: Room, signer: OwnershipSigner): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stop: Array<() => void> = []
    let timer: ReturnType<typeof setTimeout>

    // Every handler here belongs to the handshake and to nothing after it. The
    // session installs its own, and two live `onLeave` handlers reporting the
    // same disconnect differently is the kind of thing that is fine until it
    // is not.
    const done = (error?: Error): void => {
      clearTimeout(timer)
      for (const remove of stop.splice(0)) remove()
      if (error) reject(error)
      else resolve()
    }

    timer = setTimeout(
      () => done(new Error('The button room never asked this wallet to prove itself.')),
      JOIN_TIMEOUT_MS,
    )

    stop.push(
      room.onMessage(AUTH_CHALLENGE, (message: unknown) => {
        // Errors from the signer are the interesting ones — a mismatched digest
        // or a foreign domain means this is not a room worth proving anything to.
        signer.prove(message).then(
          (proof) => room.send(AUTH_PROOF, proof),
          (error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
        )
      }),
    )

    stop.push(
      room.onMessage(AUTH_RESULT, (result: AuthenticationResult) => {
        done(result?.ok ? undefined : new Error(result?.error ?? 'The button room refused this wallet.'))
      }),
    )

    const left = (): void => done(new Error('The button room closed before this wallet was verified.'))
    const failed = (_code: number, message?: string): void =>
      done(new Error(message ?? 'The button room reported an error.'))
    room.onLeave(left)
    room.onError(failed)
    stop.push(() => room.onLeave.remove(left), () => room.onError.remove(failed))
  })
}
