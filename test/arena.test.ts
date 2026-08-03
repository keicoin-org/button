/**
 * The room, over a real socket.
 *
 * `test/auth.test.ts` calls the room's methods directly, which is the right way
 * to test a decision and the wrong way to believe a wire. This file starts the
 * listener `bun run dev` starts, connects the client the browser connects with,
 * and signs with the signer the browser signs with. If the handshake only works
 * because a stub was polite, it fails here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { keyPairFromSeed, signHash } from '@keicoin/core'
import type { ClaimBundle } from 'kei-transaction'

import { bankingPolicy, startArena, type ArenaServer } from '../server/arena.js'
import { PressRegistry } from '../server/presses.js'
import type { OwnershipChallengeMessage } from '../shared/session-auth.js'
import { joinArena } from '../src/multiplayer.js'
import { ownershipSigner } from '../src/ownership.js'

const ALICE_SEED = '1'.repeat(64)
const MALLORY_SEED = '3'.repeat(64)
const ALICE = await keyPairFromSeed(ALICE_SEED, 0)
const MALLORY = await keyPairFromSeed(MALLORY_SEED, 0)

/** High and fixed. A test that picks a port at random fails differently each run. */
const PORT = Number(process.env.BUTTON_TEST_ARENA_PORT ?? 7811)

const registry = new PressRegistry()
const banked: Array<{ address: string; presses: number }> = []
let arena: ArenaServer

const bundleFor = (presses: number): ClaimBundle => ({
  root: `root-${presses}`,
  asset: 'coin',
  amount: String(presses),
  proof: [],
})

beforeAll(async () => {
  arena = await startArena({
    port: PORT,
    registry,
    bank: async (address, presses) => {
      banked.push({ address, presses })
      return bundleFor(presses)
    },
  })
})

afterAll(async () => {
  await arena.close()
})

const connect = async (seed: string) =>
  joinArena({ url: arena.url, room: arena.room, signer: await ownershipSigner(seed) })

describe('the arena over a real websocket', () => {
  test('a wallet proves itself, presses are observed, and banking spends what was seen', async () => {
    const session = await connect(ALICE_SEED)
    expect(session.address).toBe(ALICE.address)

    session.press(4)
    // The press is a message, so it has to arrive before the bank asks for it.
    // Colyseus keeps one client's messages in order, so this waits for the
    // round trip rather than for a duration.
    await settled()

    expect(registry.pending(ALICE.address)).toBe(4)
    const result = await session.bank(4)
    expect(result.presses).toBe(4)
    expect(result.claim).toEqual(bundleFor(4))
    expect(banked).toContainEqual({ address: ALICE.address, presses: 4 })
    expect(registry.pending(ALICE.address)).toBe(0)

    session.close()
  })

  test('a burst larger than one message still arrives whole', async () => {
    const session = await connect(ALICE_SEED)
    // 25 is over the ten-per-message ceiling in `server/presses.ts`, so the
    // client splits it. Sending it as one message would have it silently
    // clamped to ten, which is the bug this covers.
    session.press(25)
    await settled()

    expect(registry.pending(ALICE.address)).toBe(25)
    expect((await session.bank(25)).presses).toBe(25)
    session.close()
  })

  test('banking more than the room saw pays for what it saw and no more', async () => {
    const session = await connect(ALICE_SEED)
    session.press(3)
    await settled()

    expect((await session.bank(500)).presses).toBe(3)
    expect(banked.at(-1)).toEqual({ address: ALICE.address, presses: 3 })
    session.close()
  })

  test('a bank with nothing observed is refused with a sentence, not a proof', async () => {
    const session = await connect(ALICE_SEED)
    expect(registry.pending(ALICE.address)).toBe(0)
    expect(await refusalFrom(session.bank(5))).toContain('saw no presses')
    session.close()
  })

  test('claiming a wallet without its key never authenticates and never touches its tally', async () => {
    registry.observe(ALICE.address, 6)
    const before = banked.length

    // Mallory joins as Alice: the victim's public address in the join options,
    // and her own key on the signature. She signs the exact challenge the room
    // issued — no shortcut and no malformed message — and it still fails,
    // because the room verifies against the public key that address encodes.
    //
    // The honest signer refuses this outright, so the attack is spelled out
    // here in full. Making the test go through `ownershipSigner` would have it
    // pass on the client's good manners rather than on the room's verification.
    const impersonation = joinArena({
      url: arena.url,
      room: arena.room,
      signer: {
        address: ALICE.address,
        async prove(message: unknown) {
          const { hash } = message as OwnershipChallengeMessage
          return { signature: await signHash(MALLORY.privateKey, hash) }
        },
      },
    })

    expect(await refusalFrom(impersonation)).toBeTruthy()
    expect(registry.pending(ALICE.address)).toBe(6)
    expect(banked.length).toBe(before)

    // And the presses are still Alice's to spend once she proves the wallet.
    const alice = await connect(ALICE_SEED)
    expect((await alice.bank(6)).presses).toBe(6)
    alice.close()
  })

  test('joining without a valid kei address is refused before any challenge', async () => {
    const signer = await ownershipSigner(ALICE_SEED)
    const joining = joinArena({
      url: arena.url,
      room: arena.room,
      signer: { ...signer, address: 'kei_not_an_address' },
    })
    expect(await refusalFrom(joining)).toContain('kei address')
  })
})

describe('exactly one way to bank', () => {
  test('single-player advertises no room and leaves the HTTP route open', () => {
    expect(bankingPolicy(null)).toEqual({ closed: null })
  })

  test('a live room is advertised and closes the HTTP route in the same breath', () => {
    const policy = bankingPolicy({ url: 'ws://localhost:7778', room: 'button' })

    expect(policy.arena).toEqual({ url: 'ws://localhost:7778', room: 'button' })
    // The pair is the point: a client is told where the room is and, in the
    // same answer, that the address-only route is not an alternative to it.
    expect(policy.closed).toContain('banks through the button room')
    expect(policy.closed).toContain('BUTTON_MULTIPLAYER=off')
  })

  test('the two halves cannot disagree, whichever way it is asked', () => {
    for (const running of [null, { url: arena.url, room: arena.room }]) {
      const policy = bankingPolicy(running)
      expect(policy.arena === undefined).toBe(policy.closed === null)
    }
  })
})

/**
 * The message a rejection carried, or a sentence saying it did not reject.
 *
 * `expect(promise).rejects` is avoided throughout this file: against these
 * socket-backed promises it does not settle under `bun test`, and a matcher
 * that hangs reports a timeout instead of the assertion that failed. Reading
 * the message and asserting on it says the same thing and says it plainly.
 */
async function refusalFrom(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Long enough for a press to have crossed localhost and been counted. */
async function settled(): Promise<void> {
  await Bun.sleep(50)
}
