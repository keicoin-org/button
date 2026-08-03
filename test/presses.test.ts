import { describe, expect, test } from 'bun:test'
import type { Client } from '@colyseus/core'
import { addressFromPublicKey, type ClaimBundle } from 'kei-transaction'

import { MAX_PRESSES_PER_MESSAGE, PressRegistry } from '../server/presses.js'
import { BANK, createButtonRoom, type BankPresses, type BankResult, type ResponseClient } from '../server/room.js'

// Real addresses, derived rather than typed, because the server checks the
// checksum now: a hand-written `kei_alice` is exactly the thing it rejects.
const ALICE = addressFromPublicKey('1'.repeat(64))
const BOB = addressFromPublicKey('2'.repeat(64))

/** Alice's address with its last character bumped: right shape, wrong checksum. */
const FORGED = ALICE.slice(0, -1) + (ALICE.endsWith('a') ? 'b' : 'a')

describe('the observed-press registry', () => {
  test('an address nobody pressed for banks nothing', () => {
    const presses = new PressRegistry()
    expect(presses.consume(ALICE, 500)).toBe(0)
    expect(presses.pending(ALICE)).toBe(0)
  })

  test('presses are spent once', () => {
    const presses = new PressRegistry()
    presses.observe(ALICE, 4)
    expect(presses.consume(ALICE, 4)).toBe(4)
    expect(presses.consume(ALICE, 4)).toBe(0)
  })

  test('asking for more than was seen is given what was seen', () => {
    const presses = new PressRegistry()
    presses.observe(ALICE, 3)
    expect(presses.consume(ALICE, 1_000)).toBe(3)
  })

  test('a partial take leaves the rest for the next bank', () => {
    const presses = new PressRegistry()
    presses.observe(ALICE, 7)
    expect(presses.consume(ALICE, 2)).toBe(2)
    expect(presses.pending(ALICE)).toBe(5)
    expect(presses.consume(ALICE, 5)).toBe(5)
    expect(presses.pending(ALICE)).toBe(0)
  })

  test('a message is worth at most the documented cap', () => {
    const presses = new PressRegistry()
    expect(presses.observe(ALICE, 10_000)).toBe(MAX_PRESSES_PER_MESSAGE)
    expect(presses.pending(ALICE)).toBe(MAX_PRESSES_PER_MESSAGE)
  })

  test('counts that are not positive whole numbers are not counts', () => {
    const presses = new PressRegistry()
    for (const bad of [0, -1, 1.5, NaN, Infinity, '3', null, undefined, {}]) {
      expect(presses.observe(ALICE, bad)).toBe(0)
    }
    expect(presses.pending(ALICE)).toBe(0)

    presses.observe(ALICE, 3)
    for (const bad of [0, -1, 2.5, NaN, Infinity, '3', null, undefined]) {
      expect(presses.consume(ALICE, bad)).toBe(0)
    }
    expect(presses.pending(ALICE)).toBe(3)
  })

  test('an address whose checksum does not hold is not an address', () => {
    const presses = new PressRegistry()
    for (const bad of [FORGED, 'kei_alice', 'kei_', '', ALICE.toUpperCase(), null, undefined, 7]) {
      expect(presses.observe(bad as string, 5)).toBe(0)
    }
    expect(presses.pending(FORGED)).toBe(0)

    // ...and it cannot be used to reach a real tally, either.
    presses.observe(ALICE, 5)
    expect(presses.consume(FORGED, 5)).toBe(0)
    expect(presses.pending(ALICE)).toBe(5)
  })

  test('one player cannot bank another player’s presses', () => {
    const presses = new PressRegistry()
    presses.observe(ALICE, 6)
    presses.observe(BOB, 2)

    expect(presses.consume(BOB, 6)).toBe(2)
    expect(presses.pending(ALICE)).toBe(6)
    expect(presses.consume(ALICE, 6)).toBe(6)
  })

  test('restoring puts back exactly what was taken, cap or no cap', () => {
    const presses = new PressRegistry()
    presses.observe(ALICE, MAX_PRESSES_PER_MESSAGE)
    presses.observe(ALICE, 2)
    expect(presses.consume(ALICE, 12)).toBe(12)

    presses.restore(ALICE, 12)
    expect(presses.pending(ALICE)).toBe(12)

    for (const bad of [0, -3, 1.5, NaN, '4', null, undefined]) {
      presses.restore(ALICE, bad)
    }
    presses.restore(FORGED, 5)
    expect(presses.pending(ALICE)).toBe(12)
    expect(presses.pending(FORGED)).toBe(0)
  })
})

// ---------------------------------------------------------------------- room

/**
 * Enough of a client for the room: a session id, and somewhere for answers to
 * land. No socket, no transport, nothing to await.
 */
function stub(sessionId: string) {
  const sent: Array<{ type: string; message: unknown }> = []
  return {
    sessionId,
    send(type: string, message?: unknown) {
      sent.push({ type, message })
    },
    sent,
    /** The last thing the room said to this client. */
    last(): BankResult {
      const latest = sent.at(-1)
      expect(latest?.type).toBe(BANK)
      return latest?.message as BankResult
    },
  }
}

/** The room only ever reads `sessionId` off a joining client. */
const asClient = (client: ResponseClient): Client => client as unknown as Client

const bundleFor = (presses: number): ClaimBundle => ({
  root: `root-${presses}`,
  asset: 'coin',
  amount: String(presses),
  proof: [],
})

interface Banked {
  address: string
  presses: number
}

/**
 * A room wired to a recording issuer. `bank` resolves immediately unless a test
 * hands back a promise of its own, which is how the concurrent cases hold two
 * requests open at once without a timer.
 */
function room(bank?: BankPresses) {
  const presses = new PressRegistry()
  const calls: Banked[] = []
  const issue: BankPresses = async (address, count) => {
    calls.push({ address, presses: count })
    return bank ? await bank(address, count) : bundleFor(count)
  }
  const button = new (createButtonRoom({ bank: issue, registry: presses }))()
  button.onCreate()
  return { room: button, presses, calls }
}

describe('the room around it', () => {
  test('joining without a valid kei address is refused', () => {
    const { room: button } = room()
    const alice = stub('a')
    expect(() => button.onJoin(asClient(alice), { address: FORGED })).toThrow('kei address')
    expect(() => button.onJoin(asClient(alice), { address: 'kei_alice' })).toThrow('kei address')
    expect(() => button.onJoin(asClient(alice), {})).toThrow('kei address')
    expect(() => button.onJoin(asClient(alice))).toThrow('kei address')
  })

  test('presses land under the address the session joined with', () => {
    const { room: button, presses } = room()
    const alice = stub('a')
    button.onJoin(asClient(alice), { address: ALICE })

    expect(button.press(alice, 3)).toBe(3)
    expect(button.press(alice, { presses: 2 })).toBe(2)
    expect(presses.pending(ALICE)).toBe(5)
  })

  test('a press message cannot name an address', () => {
    const { room: button, presses } = room()
    const alice = stub('a')
    const bob = stub('b')
    button.onJoin(asClient(alice), { address: ALICE })
    button.onJoin(asClient(bob), { address: BOB })

    button.press(bob, { address: ALICE, presses: 4 })
    expect(presses.pending(ALICE)).toBe(0)
    expect(presses.pending(BOB)).toBe(4)
  })

  test('a session that never joined presses for nobody', () => {
    const { room: button, presses } = room()
    expect(button.press(stub('ghost'), 5)).toBe(0)
    expect(presses.pending(ALICE)).toBe(0)
  })

  test('a dropped socket does not drop presses that were observed', () => {
    const { room: button, presses } = room()
    const alice = stub('a')
    button.onJoin(asClient(alice), { address: ALICE })
    button.press(alice, 4)
    button.onLeave(asClient(alice))

    expect(presses.pending(ALICE)).toBe(4)
    // ...and the session is gone, so the same id cannot press again unjoined.
    expect(button.press(alice, 4)).toBe(0)
    expect(presses.consume(ALICE, 4)).toBe(4)
  })

  test('a reconnecting player keeps pressing into the same tally', () => {
    const { room: button, presses } = room()
    const first = stub('a')
    const second = stub('b')
    button.onJoin(asClient(first), { address: ALICE })
    button.press(first, 2)
    button.onLeave(asClient(first))

    button.onJoin(asClient(second), { address: ALICE })
    button.press(second, 3)
    expect(presses.consume(ALICE, 100)).toBe(5)
  })
})

describe('banking what the room saw', () => {
  test('a successful bank spends the presses once and answers the request', async () => {
    const { room: button, presses, calls } = room()
    const alice = stub('a')
    button.onJoin(asClient(alice), { address: ALICE })
    button.press(alice, 6)

    const result = await button.bank(alice, { id: 'r1', presses: 6 })
    expect(result).toEqual({ ok: true, id: 'r1', presses: 6, claim: bundleFor(6) })
    expect(alice.last()).toEqual(result)
    expect(calls).toEqual([{ address: ALICE, presses: 6 }])
    expect(presses.pending(ALICE)).toBe(0)

    // The same request replayed buys nothing, because there is nothing left.
    const replay = await button.bank(alice, { id: 'r1', presses: 6 })
    expect(replay).toEqual({ ok: false, id: 'r1', error: 'The server saw no presses to bank.' })
    expect(calls).toHaveLength(1)
  })

  test('the issuer is told what the server saw, not what was asked for', async () => {
    const { room: button, calls } = room()
    const alice = stub('a')
    button.onJoin(asClient(alice), { address: ALICE })
    button.press(alice, 3)

    const result = await button.bank(alice, { id: 7, presses: 1_000_000 })
    expect(result).toEqual({ ok: true, id: 7, presses: 3, claim: bundleFor(3) })
    expect(calls).toEqual([{ address: ALICE, presses: 3 }])
  })

  test('presses nobody observed are refused and never reach the issuer', async () => {
    const { room: button, calls } = room()
    const alice = stub('a')
    button.onJoin(asClient(alice), { address: ALICE })

    expect(await button.bank(alice, { id: 'x', presses: 50 })).toEqual({
      ok: false,
      id: 'x',
      error: 'The server saw no presses to bank.',
    })
    expect(calls).toEqual([])
    expect(alice.sent).toHaveLength(1)
  })

  test('a bank message cannot name an address or invent a count', async () => {
    const { room: button, presses, calls } = room()
    const alice = stub('a')
    const bob = stub('b')
    button.onJoin(asClient(alice), { address: ALICE })
    button.onJoin(asClient(bob), { address: BOB })
    button.press(alice, 8)

    // Bob asks for Alice's presses, by name and by count. He has none of his own.
    const stolen = await button.bank(bob, { id: 1, address: ALICE, presses: 8 })
    expect(stolen.ok).toBe(false)
    expect(calls).toEqual([])
    expect(presses.pending(ALICE)).toBe(8)

    for (const bad of [{ id: 2 }, { id: 3, presses: 0 }, { id: 4, presses: -5 }, { id: 5, presses: 2.5 }, { id: 6, presses: '4' }]) {
      const refused = await button.bank(alice, bad)
      expect(refused).toEqual({ ok: false, id: refused.id, error: 'Bank a positive whole number of presses.' })
    }
    expect(calls).toEqual([])
    expect(presses.pending(ALICE)).toBe(8)
  })

  test('a session that never joined cannot bank', async () => {
    const { room: button, calls } = room()
    const ghost = stub('ghost')
    expect(await button.bank(ghost, { id: 'g', presses: 4 })).toEqual({
      ok: false,
      id: 'g',
      error: 'Join before banking.',
    })
    expect(calls).toEqual([])
  })

  test('a failed bank restores exactly what it reserved', async () => {
    const failing: BankPresses = async () => {
      throw new Error('the node said no')
    }
    const { room: button, presses, calls } = room(failing)
    const alice = stub('a')
    button.onJoin(asClient(alice), { address: ALICE })
    button.press(alice, 10)
    button.press(alice, 2)

    const result = await button.bank(alice, { id: 'r', presses: 5 })
    expect(result).toEqual({ ok: false, id: 'r', error: 'Banking failed. Your presses are still yours.' })
    expect(calls).toEqual([{ address: ALICE, presses: 5 }])
    expect(presses.pending(ALICE)).toBe(12)

    // The whole tally, including the part the cap would refuse as a new message.
    expect(await button.bank(alice, { id: 'r2', presses: 12 })).toMatchObject({ ok: false })
    expect(presses.pending(ALICE)).toBe(12)
    expect(alice.sent).toHaveLength(2)
  })

  test('a claim that cannot be delivered is still paid for', async () => {
    const { room: button, presses, calls } = room()
    const alice = stub('a')
    button.onJoin(asClient(alice), { address: ALICE })
    button.press(alice, 6)

    // Same session, but the socket dies while the answer is going out — after
    // the issuer has already handed over a claim.
    const dropped: ResponseClient = {
      sessionId: alice.sessionId,
      send() {
        throw new Error('socket closed')
      },
    }
    await expect(button.bank(dropped, { id: 'gone', presses: 6 })).rejects.toThrow('socket closed')

    // The presses paid for that claim and stay spent: rolling them back here
    // would let the same six buy a second payout.
    expect(calls).toEqual([{ address: ALICE, presses: 6 }])
    expect(presses.pending(ALICE)).toBe(0)

    const replay = await button.bank(alice, { id: 'again', presses: 6 })
    expect(replay).toEqual({ ok: false, id: 'again', error: 'The server saw no presses to bank.' })
    expect(calls).toHaveLength(1)
  })

  test('a failure leaves the other player untouched', async () => {
    const failing: BankPresses = async (address) => {
      throw new Error(`no payout for ${address}`)
    }
    const { room: button, presses } = room(failing)
    const alice = stub('a')
    const bob = stub('b')
    button.onJoin(asClient(alice), { address: ALICE })
    button.onJoin(asClient(bob), { address: BOB })
    button.press(alice, 4)
    button.press(bob, 3)

    await button.bank(alice, { id: 1, presses: 4 })
    expect(presses.pending(ALICE)).toBe(4)
    expect(presses.pending(BOB)).toBe(3)
  })

  test('two banks in flight for one address cannot be sold the same press', async () => {
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: BankPresses = async (_address, count) => {
      await held
      return bundleFor(count)
    }
    const { room: button, presses, calls } = room(slow)
    const alice = stub('a')
    button.onJoin(asClient(alice), { address: ALICE })
    button.press(alice, 10)

    const first = button.bank(alice, { id: 'a', presses: 6 })
    const second = button.bank(alice, { id: 'b', presses: 6 })
    // Both are parked inside the issuer, and the tally is already empty: the
    // reservation happened before either of them awaited anything.
    expect(presses.pending(ALICE)).toBe(0)
    release?.()

    const results = await Promise.all([first, second])
    expect(results.map((result) => result.ok)).toEqual([true, true])
    expect(results.map((result) => (result.ok ? result.presses : 0))).toEqual([6, 4])
    expect(calls).toEqual([
      { address: ALICE, presses: 6 },
      { address: ALICE, presses: 4 },
    ])
    expect(presses.pending(ALICE)).toBe(0)
    expect(alice.sent).toHaveLength(2)
  })

  test('a third bank behind two in flight gets nothing rather than a repeat', async () => {
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: BankPresses = async (_address, count) => {
      await held
      return bundleFor(count)
    }
    const { room: button, calls } = room(slow)
    const alice = stub('a')
    button.onJoin(asClient(alice), { address: ALICE })
    button.press(alice, 5)

    const inFlight = [
      button.bank(alice, { id: 1, presses: 5 }),
      button.bank(alice, { id: 2, presses: 5 }),
      button.bank(alice, { id: 3, presses: 5 }),
    ]
    release?.()
    const results = await Promise.all(inFlight)

    expect(results.map((result) => result.ok)).toEqual([true, false, false])
    expect(calls).toEqual([{ address: ALICE, presses: 5 }])
  })

  test('the bank message handler answers over the same client', async () => {
    const { room: button, calls } = room()
    const alice = stub('a')
    button.onJoin(asClient(alice), { address: ALICE })
    button.press(alice, 2)

    // What Colyseus does when a `bank` message lands, minus the socket.
    await button.bank(asClient(alice), { id: 'wire', presses: 2 })

    expect(alice.sent).toEqual([
      { type: BANK, message: { ok: true, id: 'wire', presses: 2, claim: bundleFor(2) } },
    ])
    expect(calls).toEqual([{ address: ALICE, presses: 2 }])
  })
})
