/**
 * The boundary itself: who a request is, what this server watched it do, and how
 * much of that it is prepared to watch.
 *
 * Every test here is a **negative** one, or a bound. The happy path is proved by
 * `test/economy.test.ts`, which now plays the whole game through this door; what
 * is worth asserting here is the traffic the door is for.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { keyPairFromSeed, randomSeed, signHash, type KeyPair } from '@keicoin/core'

import { ownershipChallengeHash, signOwnershipChallenge } from '../shared/ownership.js'
import {
  DEFAULT_OBSERVATION_RATE,
  HITS_PER_MOB,
  OBSERVATION_BURST_SECONDS,
  SessionError,
  createSessions,
  type SessionRegistry,
} from '../server/sessions.js'
import { sign } from '../src/ownership.js'
import { ORIGIN, join, kill, open, press, table } from './support.js'

const running: Array<{ close(): void }> = []
afterEach(() => {
  for (const closeable of running.splice(0)) closeable.close()
})

async function board(options: Parameters<typeof table>[0] = {}) {
  const built = await table(options)
  running.push(built)
  return built
}

async function boardWithSession(options: Parameters<typeof table>[0] = {}) {
  const built = await board(options)
  return { ...built, session: await open(built.game, built.player) }
}

/** The registry on its own, with a clock a test can move and no chain behind it. */
function bare(options: { now?: () => number; refillPerSecond?: number; capacity?: number } = {}): SessionRegistry {
  return createSessions({ room: 'kei_test_room', ...options })
}

/** Open a session the honest way: real challenge, real signature, real check. */
async function prove(sessions: SessionRegistry, keys: KeyPair, origin = ORIGIN): Promise<string> {
  const challenge = sessions.challenge(keys.address, origin)
  return (await sessions.authenticate(await signOwnershipChallenge(keys, challenge), origin)).id
}

/** Press until the ceiling says no, and report how many got through. */
function drain(sessions: SessionRegistry, id: string): number {
  for (let observed = 0; observed < 10_000; observed++) {
    try {
      sessions.press(id, ORIGIN)
    } catch {
      return observed
    }
  }
  throw new Error('The ceiling never refused anything.')
}

describe('proving an address', () => {
  test('a challenge is good once — a replay of the same proof is refused', async () => {
    const { game, player } = await board()
    const proof = await sign(player, game.challenge(player.address, ORIGIN))

    expect((await game.authenticate(proof, ORIGIN)).address).toBe(player.address)
    await expect(game.authenticate(proof, ORIGIN)).rejects.toThrow('already been used')
  }, 20_000)

  test('two redemptions of one proof in flight together open one session', async () => {
    const { game, player } = await board()
    const proof = await sign(player, game.challenge(player.address, ORIGIN))

    const results = await Promise.allSettled([
      game.authenticate(proof, ORIGIN),
      game.authenticate(proof, ORIGIN),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  }, 20_000)

  test('a challenge issued for one address cannot be answered by another', async () => {
    const { game, player, node } = await board()
    const attacker = await join(node)
    running.push(attacker.player)

    // The attacker asks for the victim's challenge and signs it with their own
    // key. Spelled out rather than routed through the honest signer, so it has
    // to fail on this server's verification rather than on the client's manners.
    const challenge = game.challenge(player.address, ORIGIN)
    const keys = await keyPairFromSeed(attacker.seed, 0)
    const forged = {
      address: attacker.player.address,
      signature: await signHash(keys.privateKey, ownershipChallengeHash(challenge)),
      challenge,
    }

    await expect(game.authenticate(forged, ORIGIN)).rejects.toThrow('does not prove control of this address')
  }, 20_000)

  test('a proof made at one origin does not open a session at another', async () => {
    const { game, player } = await board()
    const proof = await sign(player, game.challenge(player.address, 'https://keicoin.org'))
    await expect(game.authenticate(proof, 'https://evil.example')).rejects.toThrow('different origin')
  }, 20_000)

  test('a proof made against one running issuer does not open a session on the next', async () => {
    const first = await board()
    const second = await board()

    // Two games, two rooms. The room is signed into the challenge, so a proof
    // harvested from a local dev server is not a session on the deployed one,
    // and a proof from before an issuer restart is not a session after it.
    expect(first.game.room).not.toBe(second.game.room)
    const proof = await sign(first.player, first.game.challenge(first.player.address, ORIGIN))
    await expect(second.game.authenticate(proof, ORIGIN)).rejects.toThrow('never issued here')
  }, 30_000)

  test('a challenge that sat too long is refused rather than honoured late', async () => {
    let clock = 1_000_000
    const sessions = bare({ now: () => clock })
    const keys = await keyPairFromSeed(randomSeed(), 0)

    const proof = await signOwnershipChallenge(keys, sessions.challenge(keys.address, ORIGIN))
    clock += 61_000
    await expect(sessions.authenticate(proof, ORIGIN)).rejects.toThrow('never issued here')
  })
})

describe('a session id is not an address', () => {
  test('a made-up session id buys nothing', async () => {
    const { game } = await board()
    for (const forged of ['', 'session', 'A'.repeat(64), null, 42, {}]) {
      await expect(game.bank(forged, ORIGIN)).rejects.toThrow(SessionError)
    }
  }, 20_000)

  test('a session used from another origin is refused', async () => {
    const { game, session } = await boardWithSession()
    press(game, session, 3)
    expect(() => game.press(session, 'https://evil.example')).toThrow('different origin')
    await expect(game.bank(session, 'https://evil.example')).rejects.toThrow('different origin')
  }, 20_000)

  test('one session cannot bank another session’s presses', async () => {
    const { game, node } = await board()
    const [honest, thief] = [await join(node), await join(node)]
    running.push(honest.player, thief.player)

    const theirs = await open(game, honest.player)
    const mine = await open(game, thief.player)
    press(game, theirs, 10)

    // The thief is authenticated — for their own address — and has been watched
    // doing nothing. Being a valid session is not being that session.
    await expect(game.bank(mine, ORIGIN)).rejects.toThrow('has not seen any presses from you yet')
  }, 30_000)
})

describe('a forged kill', () => {
  test('loot without a kill is refused, whatever is put in the event', async () => {
    const { game, session } = await boardWithSession()
    for (const forged of ['slime-1', 'A'.repeat(64), '', null, 42]) {
      await expect(game.loot(session, ORIGIN, forged)).rejects.toThrow(SessionError)
    }
  }, 20_000)

  test('a mob takes more than one hit, and only the last one is an event', async () => {
    const { game, session } = await boardWithSession()
    for (let index = 1; index < HITS_PER_MOB; index++) {
      expect(game.hit(session, ORIGIN, 'slime-1').event).toBeUndefined()
    }
    expect(game.hit(session, ORIGIN, 'slime-1').event).toMatch(/^[0-9A-F]{64}$/)
  }, 20_000)

  test('a kill event belongs to the session that earned it', async () => {
    const { game, node } = await board()
    const [honest, thief] = [await join(node), await join(node)]
    running.push(honest.player, thief.player)

    const theirs = await open(game, honest.player)
    const mine = await open(game, thief.player)
    const event = kill(game, theirs, 'slime-3')

    await expect(game.loot(mine, ORIGIN, event)).rejects.toThrow('different session')
  }, 30_000)

  test('a mob already paid for cannot be farmed from a fresh session', async () => {
    const { game, player } = await board()
    const first = await open(game, player)
    await game.loot(first, ORIGIN, kill(game, first, 'slime-1'))

    // A reconnect is not a respawn. The drop is remembered against the proven
    // address, so re-proving the same wallet does not put the slime back.
    const second = await open(game, player)
    expect(() => game.hit(second, ORIGIN, 'slime-1')).toThrow('already dead')
  }, 30_000)

  test('a mob that does not exist is not a mob', async () => {
    const { game, session } = await boardWithSession()
    for (const mob of ['slime-4', 'dragon', '../slime-1', '', null]) {
      expect(() => game.hit(session, ORIGIN, mob)).toThrow('does not exist')
    }
  }, 20_000)
})

/**
 * The ceiling — button#12 and create-kei-game#42 written as assertions.
 *
 * The property is not "one call returns a small number". The formula this
 * replaced satisfied that and still handed out 5,200 coins a second, because
 * every request arrived with a fresh grant and nothing was ever subtracted. The
 * property is that the **total over a period is bounded**, however the requests
 * are arranged: in a tight loop, across reconnects, interleaved between
 * sessions, or after any amount of idling.
 */
describe('the observation ceiling', () => {
  test('a tight loop of requests is bounded by the burst, not multiplied by it', async () => {
    let clock = 1_000_000
    const sessions = bare({ now: () => clock, refillPerSecond: 25 })
    const keys = await keyPairFromSeed(randomSeed(), 0)

    // Four hundred requests inside one instant, and the clock does not move —
    // which is the shape of a script, and was worth 400 presses before.
    expect(drain(sessions, await prove(sessions, keys))).toBe(25 * OBSERVATION_BURST_SECONDS)
  }, 20_000)

  test('idling buys back one burst and never more', async () => {
    let clock = 1_000_000
    const sessions = bare({ now: () => clock, refillPerSecond: 25 })
    const keys = await keyPairFromSeed(randomSeed(), 0)

    drain(sessions, await prove(sessions, keys))
    // An hour of quiet — long enough that the session is gone and the wallet
    // proves itself again, which is the realistic shape of coming back. The
    // formula this replaces would have honoured 90,025 presses on the next
    // request, and a day would have been 2,160,025.
    clock += 3_600_000
    expect(drain(sessions, await prove(sessions, keys))).toBe(50)

    clock += 86_400_000
    expect(drain(sessions, await prove(sessions, keys))).toBe(50)
  }, 20_000)

  test('the ceiling is the address, so reconnecting does not lift it', async () => {
    let clock = 1_000_000
    const sessions = bare({ now: () => clock, refillPerSecond: 25 })
    const keys = await keyPairFromSeed(randomSeed(), 0)

    // Twenty sessions for one wallet — every reconnect, every tab, every retry.
    let observed = 0
    for (let index = 0; index < 20; index++) observed += drain(sessions, await prove(sessions, keys))
    expect(observed).toBe(50)
  }, 30_000)

  test('parallel sessions for one address divide the ceiling rather than each getting one', async () => {
    let clock = 1_000_000
    const sessions = bare({ now: () => clock, refillPerSecond: 25 })
    const keys = await keyPairFromSeed(randomSeed(), 0)
    const ids = [await prove(sessions, keys), await prove(sessions, keys), await prove(sessions, keys)]

    // Round-robin, which is what concurrent requests look like to a server that
    // handles one at a time. The interleaving must not buy anything.
    let observed = 0
    for (let round = 0; round < 100; round++) {
      for (const id of ids) {
        try {
          sessions.press(id, ORIGIN)
          observed += 1
        } catch {
          /* this address is spent, and it is one address */
        }
      }
    }
    expect(observed).toBe(50)
  }, 20_000)

  test('a forgotten bucket is a full one, so sweeping is not a reset', async () => {
    let clock = 1_000_000
    const sessions = bare({ now: () => clock, refillPerSecond: 25 })
    const keys = await keyPairFromSeed(randomSeed(), 0)

    drain(sessions, await prove(sessions, keys))
    // Long enough for the sweep to reach it — but a bucket is only dropped once
    // time has refilled it to full, so what is forgotten is a full bucket.
    clock += 40 * 60_000
    expect(drain(sessions, await prove(sessions, keys))).toBe(50)
  }, 20_000)

  test('hits come out of the same budget as presses', async () => {
    let clock = 1_000_000
    const sessions = bare({ now: () => clock, refillPerSecond: 25 })
    const keys = await keyPairFromSeed(randomSeed(), 0)
    const id = await prove(sessions, keys)

    for (let index = 0; index < 20; index++) sessions.press(id, ORIGIN)
    let hits = 0
    for (;;) {
      try {
        sessions.hit(id, ORIGIN, 'slime-1')
        hits += 1
      } catch {
        break
      }
    }
    expect(hits).toBe(30)
  }, 20_000)

  test('the default is a human rate rather than a scripted one', async () => {
    const sessions = bare()
    const keys = await keyPairFromSeed(randomSeed(), 0)
    expect(DEFAULT_OBSERVATION_RATE).toBe(25)
    expect(drain(sessions, await prove(sessions, keys))).toBe(
      DEFAULT_OBSERVATION_RATE * OBSERVATION_BURST_SECONDS,
    )
  }, 20_000)
})

describe('the payout is what was observed', () => {
  test('a bank pays for the presses that arrived and nothing more', async () => {
    const { game, player, session } = await boardWithSession()
    const coins = await player.token(game.catalogue().coin.asset)

    press(game, session, 7)
    await player.claims.add(await game.bank(session, ORIGIN))
    expect(await coins.balance()).toBe(7)

    // Nothing has been watched since, so there is nothing to be paid for.
    await expect(game.bank(session, ORIGIN)).rejects.toThrow('has not seen any presses from you yet')
  }, 30_000)

  test('presses the ceiling refused are never paid for', async () => {
    const { game, player, session } = await boardWithSession({ pressRateCap: 5, pressBurst: 10 })
    const coins = await player.token(game.catalogue().coin.asset)

    let refused = 0
    for (let index = 0; index < 200; index++) {
      try {
        game.press(session, ORIGIN)
      } catch {
        refused += 1
      }
    }
    expect(refused).toBeGreaterThan(150)

    await player.claims.add(await game.bank(session, ORIGIN))
    // The burst, plus whatever the real clock refilled while 200 calls ran —
    // which is a fraction of a second, so a handful at five a second.
    expect(await coins.balance()).toBeGreaterThanOrEqual(10)
    expect(await coins.balance()).toBeLessThanOrEqual(15)
  }, 30_000)
})
