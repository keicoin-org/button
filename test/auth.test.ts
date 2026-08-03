import { describe, expect, test } from 'bun:test'
import type { Client } from '@colyseus/core'
import { keyPairFromSeed, signHash, type KeyPair } from '@keicoin/core'
import type { ClaimBundle } from 'kei-transaction'

import {
  AUTH_CHALLENGE,
  AUTH_RESULT,
  ownershipChallengeHash,
  verifyOwnershipProof,
  type ChallengeTokenFactory,
  type OwnershipChallenge,
  type OwnershipChallengeMessage,
} from '../server/auth.js'
import { PressRegistry } from '../server/presses.js'
import {
  createButtonRoom,
  type ButtonRoom,
  type ResponseClient,
  type ScheduleAuthenticationDeadline,
} from '../server/room.js'

const ALICE = await keyPairFromSeed('1'.repeat(64), 0)
const BOB = await keyPairFromSeed('2'.repeat(64), 0)

const TOKENS = {
  playerId: 'A'.repeat(64),
  nonce: 'B'.repeat(64),
} as const

function tokenSequence(): ChallengeTokenFactory {
  let sequence = 0
  return () => {
    sequence += 1
    return {
      playerId: sequence.toString(16).padStart(64, '0'),
      nonce: (sequence + 10_000).toString(16).padStart(64, '0'),
    }
  }
}

function stub(sessionId: string) {
  const sent: Array<{ type: string; message: unknown }> = []
  const left: Array<{ code?: number; data?: string }> = []
  return {
    sessionId,
    send(type: string, message?: unknown) {
      sent.push({ type, message })
    },
    sent,
    leave(code?: number, data?: string) {
      left.push({ ...(code === undefined ? {} : { code }), ...(data === undefined ? {} : { data }) })
    },
    left,
  }
}

const asClient = (client: ResponseClient): Client => client as unknown as Client

function room(options: {
  roomId?: string
  registry?: PressRegistry
  tokens?: ChallengeTokenFactory
  authenticationDeadlineMs?: number
  scheduleAuthenticationDeadline?: ScheduleAuthenticationDeadline
} = {}) {
  const calls: Array<{ address: string; presses: number }> = []
  const registry = options.registry ?? new PressRegistry()
  const RoomClass = createButtonRoom({
    registry,
    challengeTokens: options.tokens ?? tokenSequence(),
    ...(options.authenticationDeadlineMs === undefined
      ? {}
      : { authenticationDeadlineMs: options.authenticationDeadlineMs }),
    ...(options.scheduleAuthenticationDeadline === undefined
      ? {}
      : { scheduleAuthenticationDeadline: options.scheduleAuthenticationDeadline }),
    bank: async (address, presses) => {
      calls.push({ address, presses })
      return bundleFor(presses)
    },
  })
  const button = new RoomClass()
  ;(button as { roomId: string }).roomId = options.roomId ?? 'room-a'
  button.onCreate()
  return { button, registry, calls }
}

function challengeFor(button: ButtonRoom, client: ReturnType<typeof stub>, address: string): OwnershipChallengeMessage {
  button.onJoin(asClient(client), { address })
  const envelope = client.sent.at(-1)
  expect(envelope?.type).toBe(AUTH_CHALLENGE)
  return envelope?.message as OwnershipChallengeMessage
}

async function signatureFor(keys: KeyPair, message: OwnershipChallengeMessage): Promise<string> {
  return signHash(keys.privateKey, message.hash)
}

const bundleFor = (presses: number): ClaimBundle => ({
  root: `root-${presses}`,
  asset: 'coin',
  amount: String(presses),
  proof: [],
})

function manualDeadlines() {
  const jobs: Array<{ active: boolean; afterMs: number; expires(): void }> = []
  const schedule: ScheduleAuthenticationDeadline = (expires, afterMs) => {
    const job = { active: true, afterMs, expires }
    jobs.push(job)
    return () => {
      job.active = false
    }
  }
  const fire = (index = 0): void => {
    const job = jobs[index]
    if (job?.active) job.expires()
  }
  return { jobs, schedule, fire }
}

describe('wallet ownership challenge', () => {
  test('binds every identity and replay dimension into one canonical digest', () => {
    const { button } = room({ roomId: 'room-bound', tokens: () => TOKENS })
    const client = stub('session-bound')
    const message = challengeFor(button, client, ALICE.address)

    expect(message.challenge).toEqual({
      domain: 'keicoin.org/button/session-ownership/v1',
      version: 1,
      address: ALICE.address,
      roomId: 'room-bound',
      sessionId: 'session-bound',
      playerId: TOKENS.playerId,
      nonce: TOKENS.nonce,
    })
    expect(message.hash).toBe(ownershipChallengeHash(message.challenge))
    expect(message.hash).toMatch(/^[0-9A-F]{64}$/)
    button.onLeave(asClient(client))
  })

  test('accepts a real Kei signature only for the exact challenge', async () => {
    const { button } = room({ tokens: () => TOKENS })
    const client = stub('alice-session')
    const message = challengeFor(button, client, ALICE.address)
    const signature = await signatureFor(ALICE, message)

    expect(await button.authenticate(client, { signature })).toEqual({ ok: true })
    expect(client.sent.at(-1)).toEqual({ type: AUTH_RESULT, message: { ok: true } })
    expect(button.press(client, 3)).toBe(3)
  })

  test('changes to room, session, player, nonce, or address invalidate the proof', async () => {
    const { button } = room({ roomId: 'room-original', tokens: () => TOKENS })
    const client = stub('session-original')
    const original = challengeFor(button, client, ALICE.address).challenge

    const variants: OwnershipChallenge[] = [
      { ...original, roomId: 'room-other' },
      { ...original, sessionId: 'session-other' },
      { ...original, playerId: 'C'.repeat(64) },
      { ...original, nonce: 'D'.repeat(64) },
      { ...original, address: BOB.address },
    ]

    for (const altered of variants) {
      const alteredSignature = await signHash(ALICE.privateKey, ownershipChallengeHash(altered))
      expect(await verifyOwnershipProof(original, { signature: alteredSignature })).toBe(false)
    }
    button.onLeave(asClient(client))
  })
})

describe('room authorization boundary', () => {
  test('an unauthenticated victim impersonator cannot create, consume, or withhold victim presses', async () => {
    const registry = new PressRegistry()
    registry.observe(ALICE.address, 5)
    const { button, calls } = room({ registry })
    const attacker = stub('attacker')
    const victimChallenge = challengeFor(button, attacker, ALICE.address)

    expect(button.press(attacker, 7)).toBe(0)
    expect(await button.bank(attacker, { id: 'steal', presses: 5 })).toEqual({
      ok: false,
      id: 'steal',
      error: 'Authenticate your Kei wallet before banking.',
    })
    expect(registry.pending(ALICE.address)).toBe(5)
    expect(calls).toEqual([])

    const attackerSignature = await signatureFor(BOB, victimChallenge)
    const refused = await button.authenticate(attacker, { signature: attackerSignature })
    expect(refused.ok).toBe(false)
    expect(attacker.left).toEqual([{ code: 4001, data: 'Wallet authentication failed.' }])
    expect(JSON.stringify(refused)).not.toContain(attackerSignature)
    expect(JSON.stringify(refused)).not.toContain(victimChallenge.challenge.nonce)

    // The bad attempt consumed the challenge. Even a later valid signature is
    // a replay and cannot turn this socket into Alice.
    const lateVictimSignature = await signatureFor(ALICE, victimChallenge)
    expect((await button.authenticate(attacker, { signature: lateVictimSignature })).ok).toBe(false)
    expect(button.press(attacker, 2)).toBe(0)
    expect(registry.pending(ALICE.address)).toBe(5)
    expect(calls).toEqual([])
  })

  test('a concurrent duplicate closes the unauthenticated attempt so neither can race authorization', async () => {
    const { button } = room({ tokens: () => TOKENS })
    const alice = stub('alice')
    const challenge = challengeFor(button, alice, ALICE.address)
    const signature = await signatureFor(ALICE, challenge)

    const first = button.authenticate(alice, { signature })
    const duplicate = button.authenticate(alice, { signature })
    const [accepted, replayed] = await Promise.all([first, duplicate])

    expect(accepted.ok).toBe(false)
    expect(replayed.ok).toBe(false)
    expect(alice.left).toHaveLength(1)
    expect(button.press(alice, 1)).toBe(0)
  })

  test('a signature cannot cross sessions even for the same address', async () => {
    const { button, registry } = room()
    const first = stub('first')
    const second = stub('second')
    const firstChallenge = challengeFor(button, first, ALICE.address)
    challengeFor(button, second, ALICE.address)
    const firstSignature = await signatureFor(ALICE, firstChallenge)

    expect((await button.authenticate(second, { signature: firstSignature })).ok).toBe(false)
    expect(button.press(second, 4)).toBe(0)
    expect(registry.pending(ALICE.address)).toBe(0)

    expect(await button.authenticate(first, { signature: firstSignature })).toEqual({ ok: true })
    expect(button.press(first, 4)).toBe(4)
  })

  test('a signature cannot cross rooms even if every other field and random token repeats', async () => {
    const sameTokens = () => TOKENS
    const { button: firstRoom } = room({ roomId: 'room-first', tokens: sameTokens })
    const { button: secondRoom, registry } = room({ roomId: 'room-second', tokens: sameTokens })
    const first = stub('same-session')
    const second = stub('same-session')
    const firstChallenge = challengeFor(firstRoom, first, ALICE.address)
    challengeFor(secondRoom, second, ALICE.address)
    const firstSignature = await signatureFor(ALICE, firstChallenge)

    expect((await secondRoom.authenticate(second, { signature: firstSignature })).ok).toBe(false)
    expect(secondRoom.press(second, 2)).toBe(0)
    expect(registry.pending(ALICE.address)).toBe(0)
    firstRoom.onLeave(asClient(first))
  })

  test('an unanswered challenge expires, closes the socket, and never reaches shared state', async () => {
    const deadlines = manualDeadlines()
    const { button, registry, calls } = room({
      authenticationDeadlineMs: 250,
      scheduleAuthenticationDeadline: deadlines.schedule,
    })
    const claimant = stub('idle-claimant')
    challengeFor(button, claimant, ALICE.address)

    expect(deadlines.jobs).toHaveLength(1)
    expect(deadlines.jobs[0]?.afterMs).toBe(250)
    deadlines.fire()

    expect(claimant.left).toEqual([{ code: 4001, data: 'Wallet authentication failed.' }])
    expect(button.press(claimant, 4)).toBe(0)
    expect(registry.pending(ALICE.address)).toBe(0)
    expect(calls).toEqual([])
  })

  test('the deadline covers verification and cannot authorize after it fires', async () => {
    const deadlines = manualDeadlines()
    const { button, registry } = room({
      authenticationDeadlineMs: 250,
      scheduleAuthenticationDeadline: deadlines.schedule,
      tokens: () => TOKENS,
    })
    const alice = stub('slow-proof')
    const challenge = challengeFor(button, alice, ALICE.address)
    const signature = await signatureFor(ALICE, challenge)

    const verifying = button.authenticate(alice, { signature })
    deadlines.fire()

    expect((await verifying).ok).toBe(false)
    expect(alice.left).toHaveLength(1)
    expect(button.press(alice, 2)).toBe(0)
    expect(registry.pending(ALICE.address)).toBe(0)
  })

  test('successful authentication cancels its deadline', async () => {
    const deadlines = manualDeadlines()
    const { button } = room({ scheduleAuthenticationDeadline: deadlines.schedule, tokens: () => TOKENS })
    const alice = stub('quick-proof')
    const challenge = challengeFor(button, alice, ALICE.address)
    const signature = await signatureFor(ALICE, challenge)

    expect(await button.authenticate(alice, { signature })).toEqual({ ok: true })
    expect(deadlines.jobs[0]?.active).toBe(false)
    deadlines.fire()
    expect(alice.left).toEqual([])
    expect(button.press(alice, 2)).toBe(2)
  })

  test('leaving before proof cancels the pending deadline', () => {
    const deadlines = manualDeadlines()
    const { button } = room({ scheduleAuthenticationDeadline: deadlines.schedule })
    const alice = stub('left-pending')
    challengeFor(button, alice, ALICE.address)

    button.onLeave(asClient(alice))
    expect(deadlines.jobs[0]?.active).toBe(false)
    deadlines.fire()
    expect(alice.left).toEqual([])
  })

  test('malformed proof objects are rejected and consume their challenge', async () => {
    const malformed = [
      null,
      undefined,
      {},
      { signature: 'A'.repeat(127) },
      { signature: 'A'.repeat(128), address: ALICE.address },
      ['A'.repeat(128)],
    ]
    for (const [index, bad] of malformed.entries()) {
      const { button } = room()
      const client = stub(`malformed-${index}`)
      const challenge = challengeFor(button, client, ALICE.address)
      expect((await button.authenticate(client, bad)).ok).toBe(false)
      expect(client.left).toHaveLength(1)

      const valid = await signatureFor(ALICE, challenge)
      expect((await button.authenticate(client, { signature: valid })).ok).toBe(false)
      expect(button.press(client, 1)).toBe(0)
    }
  })

  test('leaving during verification cannot resurrect the session', async () => {
    const { button, registry } = room({ tokens: () => TOKENS })
    const alice = stub('leaving')
    const challenge = challengeFor(button, alice, ALICE.address)
    const signature = await signatureFor(ALICE, challenge)

    const verifying = button.authenticate(alice, { signature })
    button.onLeave(asClient(alice))
    expect((await verifying).ok).toBe(false)
    expect(button.press(alice, 3)).toBe(0)
    expect(registry.pending(ALICE.address)).toBe(0)
  })
})
