/**
 * The two front doors, driven over HTTP.
 *
 * Issue #10's evidence names both `server/main.ts` and `worker/index.ts`,
 * because the same trust boundary was written out twice and only one copy would
 * have been noticed if it were fixed once. So both are exercised here, and each
 * case is asserted against **both** — `forEachDoor` runs every negative test
 * through the Bun server and through the deployed Worker's router.
 *
 * What is real about each:
 *
 *   - The Bun door is a real `Bun.serve` on a real port, reached with `fetch`.
 *   - The Worker door is `worker/router.ts`, the module the Durable Object's
 *     `fetch` delegates to, called with the mounted URLs a browser really sends
 *     (`/examples/button/game/...`). It is not `workerd`: what `worker/index.ts`
 *     keeps is booting a chain and keeping it, and a `cloudflare:workers` import
 *     cannot be loaded under `bun test`. The deployment check that closes that
 *     gap is a live no-cache fetch against keicoin.org, in the PR.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { keyPairFromSeed, randomSeed } from '@keicoin/core'

import { handleGameApi } from '../server/api.js'
import { handleArenaRequest } from '../worker/router.js'
import type { Game } from '../server/game.js'
import { sign } from '../src/ownership.js'
import { batchName, join, table, type Table } from './support.js'

const running: Array<{ close(): void }> = []
afterEach(() => {
  for (const closeable of running.splice(0)) closeable.close()
})

/** Post to a game, however that game is reached. */
type Door = (path: string, body: unknown, origin?: string) => Promise<{ status: number; body: any }>

interface Arena extends Table {
  door: Door
  origin: string
}

/** `bun run dev`: a real listener, reached over the network. */
async function bunDoor(options: Parameters<typeof table>[0] = {}): Promise<Arena> {
  const built = await table(options)
  const server = Bun.serve({
    port: 0,
    routes: {
      '/game/*': async (request) => {
        const path = new URL(request.url).pathname
        return (await handleGameApi(built.game, path, request)) ?? new Response('Not found', { status: 404 })
      },
    },
  })
  const origin = new URL(server.url).origin
  running.push(built, { close: () => void server.stop(true) })

  return {
    ...built,
    origin,
    async door(path, body, from = origin) {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: from },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    },
  }
}

/** The deployed Worker: the same requests, at the mount point it is served from. */
async function workerDoor(options: Parameters<typeof table>[0] = {}): Promise<Arena> {
  const built = await table(options)
  running.push(built)
  const origin = 'https://keicoin.org'
  const rpc = async (): Promise<Response> => new Response('rpc', { status: 200 })

  return {
    ...built,
    origin,
    async door(path, body, from = origin) {
      const response = await handleArenaRequest(
        built.game,
        rpc,
        new Request(`${origin}/examples/button${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: from },
          body: JSON.stringify(body),
        }),
      )
      return { status: response.status, body: await response.json() }
    },
  }
}

const doors = [
  ['the Bun server', bunDoor],
  ['the deployed Worker', workerDoor],
] as const

function forEachDoor(
  what: string,
  run: (arena: Arena) => Promise<void>,
  options: Parameters<typeof table>[0] & { timeout?: number } = {},
): void {
  const { timeout = 30_000, ...built } = options
  for (const [name, build] of doors) {
    test(`${what} — ${name}`, async () => run(await build(built)), timeout)
  }
}

/** Prove the player's address through the door, exactly as the browser does. */
async function authenticate(arena: Arena): Promise<string> {
  const { body: issued } = await arena.door('/game/session/challenge', { address: arena.player.address })
  const proof = await sign(arena.player, issued.challenge)
  const { body: opened } = await arena.door('/game/session', { proof })
  return opened.session as string
}

async function pressThrough(arena: Arena, session: string, times: number): Promise<void> {
  for (let index = 0; index < times; index++) await arena.door('/game/press', { session })
}

describe('a caller cannot state its own reward', () => {
  forEachDoor('a bank without a session is refused', async (arena) => {
    // The exact request from issue #10's reproduction, at the exact URL.
    const { status, body } = await arena.door('/game/bank', {
      address: arena.player.address,
      presses: 1_000_000,
      batch: batchName(),
    })
    expect(status).toBe(400)
    expect(body.bundle).toBeUndefined()
    expect(body.error).toMatch(/Prove your address/)
  })

  forEachDoor('a press count in the body is not read, however large', async (arena) => {
    const session = await authenticate(arena)
    await pressThrough(arena, session, 3)

    // Three presses were watched. The body says a million, and says it in every
    // spelling the old route understood.
    const { status, body } = await arena.door('/game/bank', {
      session,
      batch: batchName(),
      presses: 1_000_000,
      count: 1_000_000,
      amount: 1_000_000,
      address: arena.player.address,
    })
    expect(status).toBe(200)
    await arena.player.claims.add(body.bundle)
    const coins = await arena.player.token(arena.game.catalogue().coin.asset)
    expect(await coins.balance()).toBe(3)
  })

  forEachDoor('a session cannot be pointed at somebody else’s address', async (arena) => {
    const session = await authenticate(arena)
    await pressThrough(arena, session, 4)

    // A body naming a victim. The payout goes to the proven wallet regardless,
    // because the address is not something this route reads.
    const victim = (await keyPairFromSeed(randomSeed(), 0)).address
    const { body } = await arena.door('/game/bank', { session, batch: batchName(), address: victim })
    const coins = await arena.player.token(arena.game.catalogue().coin.asset)
    await arena.player.claims.add(body.bundle)
    expect(await coins.balance()).toBe(4)
    expect(await coins.balanceOf(victim)).toBe(0)
  })
})

/**
 * Issue #17: a bank cannot be retried unless the attempt has a name.
 *
 * The failure it is about does not look like a failure from here. `bank()` takes
 * the observed tally and publishes the entitlement before it can answer, so a
 * response lost on the way back leaves coins committed on the chain whose only
 * proof was in that response — unclaimable by the player, unprunable by every
 * node, and invisible to both sides. What the tests below assert is that asking
 * again under the same name is answered with the proof that was already
 * published, rather than with a refusal or with a second root.
 */
describe('a lost response can be asked for again', () => {
  forEachDoor('a bank that does not name its batch is refused', async (arena) => {
    const session = await authenticate(arena)
    await pressThrough(arena, session, 4)

    const { status, body } = await arena.door('/game/bank', { session })
    expect(status).toBe(400)
    expect(body.bundle).toBeUndefined()
    expect(body.error).toMatch(/batch id/)

    // And the presses are still there to be banked, because nothing was spent.
    const named = await arena.door('/game/bank', { session, batch: batchName() })
    await arena.player.claims.add(named.body.bundle)
    const coins = await arena.player.token(arena.game.catalogue().coin.asset)
    expect(await coins.balance()).toBe(4)
  })

  forEachDoor('asking twice under one name is answered with the same proof', async (arena) => {
    const session = await authenticate(arena)
    await pressThrough(arena, session, 20)

    const batch = batchName()
    const first = await arena.door('/game/bank', { session, batch })
    expect(first.status).toBe(200)

    // The response the player never saw, asked for again. Before the batch id
    // this refused — the tally it was paid for was already spent — and the
    // twenty coins in the first root could never be collected by anybody.
    const again = await arena.door('/game/bank', { session, batch })
    expect(again.status).toBe(200)
    // The same root, so no second commit block was published for these presses.
    expect(again.body.bundle.root).toBe(first.body.bundle.root)
    expect(again.body.bundle).toEqual(first.body.bundle)

    await arena.player.claims.add(again.body.bundle)
    const coins = await arena.player.token(arena.game.catalogue().coin.asset)
    expect(await coins.balance()).toBe(20)
  })

  forEachDoor('a batch is answered to the wallet that opened it and to no other', async (arena) => {
    const mine = await authenticate(arena)
    await pressThrough(arena, mine, 6)

    const batch = batchName()
    const paid = await arena.door('/game/bank', { session: mine, batch })
    expect(paid.status).toBe(200)

    // A second wallet, proving its own address honestly, guessing at the name.
    const { player: other } = await join(arena.node)
    running.push(other)
    const { body: issued } = await arena.door('/game/session/challenge', { address: other.address })
    const proof = await sign(other, issued.challenge)
    const { body: opened } = await arena.door('/game/session', { proof })

    const stolen = await arena.door('/game/bank', { session: opened.session, batch })
    expect(stolen.status).toBe(400)
    expect(stolen.body.bundle).toBeUndefined()
    expect(stolen.body.error).toMatch(/different wallet/)
  })
})

describe('a caller cannot assert a kill', () => {
  forEachDoor('loot with a mob name instead of an event pays nothing', async (arena) => {
    const session = await authenticate(arena)
    // The old route's body, unchanged. `slime-1` was worth 25 coins for free.
    const { status, body } = await arena.door('/game/loot', {
      session,
      mob: 'slime-1',
      address: arena.player.address,
    })
    expect(status).toBe(400)
    expect(body.bundle).toBeUndefined()

    const coins = await arena.player.token(arena.game.catalogue().coin.asset)
    expect(await coins.balance()).toBe(0)
  })

  forEachDoor('a mob has to be fought before its drop exists', async (arena) => {
    const session = await authenticate(arena)

    let event: string | undefined
    for (let blow = 0; blow < 3 && !event; blow++) {
      const { body } = await arena.door('/game/hit', { session, mob: 'slime-1' })
      event = body.event
    }
    expect(event).toBeString()

    const { body } = await arena.door('/game/loot', { session, event })
    await arena.player.claims.add(body.bundle)
    const coins = await arena.player.token(arena.game.catalogue().coin.asset)
    expect(await coins.balance()).toBe(25)

    // And the event is spent.
    const again = await arena.door('/game/loot', { session, event })
    expect(again.status).toBe(400)
  })
})

describe('a proof is not reusable', () => {
  forEachDoor('replaying the same proof does not open a second session', async (arena) => {
    const { body: issued } = await arena.door('/game/session/challenge', { address: arena.player.address })
    const proof = await sign(arena.player, issued.challenge)

    const first = await arena.door('/game/session', { proof })
    expect(first.status).toBe(200)

    const replay = await arena.door('/game/session', { proof })
    expect(replay.status).toBe(400)
    expect(replay.body.session).toBeUndefined()
  })

  forEachDoor('a session id from one origin is refused at another', async (arena) => {
    const session = await authenticate(arena)
    const { status, body } = await arena.door('/game/press', { session }, 'https://evil.example')
    expect(status).toBe(400)
    expect(body.error).toMatch(/different origin/)
  })

  forEachDoor('a challenge answered from another origin opens nothing', async (arena) => {
    const { body: issued } = await arena.door(
      '/game/session/challenge',
      { address: arena.player.address },
      'https://evil.example',
    )
    const proof = await sign(arena.player, issued.challenge)
    const { status } = await arena.door('/game/session', { proof })
    expect(status).toBe(400)
  })
})

describe('parallel requests', () => {
  forEachDoor('twenty banks at once do not sell one tally twenty times', async (arena) => {
    const session = await authenticate(arena)
    await pressThrough(arena, session, 12)

    // Twenty different names, because twenty different batches is what this is
    // about. Twenty of one name is the retry, and it is tested below.
    const banks = await Promise.all(
      Array.from({ length: 20 }, () => arena.door('/game/bank', { session, batch: batchName() })),
    )
    const paid = banks.filter((bank) => bank.status === 200)
    expect(paid).toHaveLength(1)

    await arena.player.claims.add(paid[0]!.body.bundle)
    const coins = await arena.player.token(arena.game.catalogue().coin.asset)
    expect(await coins.balance()).toBe(12)
  })

  forEachDoor(
    'a flood of presses is bounded by the ceiling rather than by how fast they arrive',
    async (arena) => {
      const session = await authenticate(arena)

      // Four hundred presses as fast as the transport will carry them. Under the
      // formula this replaces, each request carried its own fresh grant.
      const results = await Promise.all(
        Array.from({ length: 400 }, () => arena.door('/game/press', { session })),
      )
      const watched = results.filter((result) => result.status === 200).length
      expect(watched).toBeLessThanOrEqual(15)
      expect(watched).toBeGreaterThanOrEqual(10)

      const { body } = await arena.door('/game/bank', { session, batch: batchName() })
      await arena.player.claims.add(body.bundle)
      const coins = await arena.player.token(arena.game.catalogue().coin.asset)
      expect(await coins.balance()).toBe(watched)
    },
    // A real ceiling, because this is the test that is about one.
    { pressRateCap: 5, pressBurst: 10, timeout: 60_000 },
  )
})

describe('the claim flow is unchanged', () => {
  forEachDoor('the server publishes the entitlement and the wallet claims it', async (arena) => {
    const session = await authenticate(arena)
    await pressThrough(arena, session, 5)

    const { body } = await arena.door('/game/bank', { session, batch: batchName() })
    // Still a rooted claim bundle, still claimed by the player's own wallet from
    // the player's own chain. Authentication decides who may be paid; it does
    // not become the thing that pays.
    expect(body.bundle.root).toMatch(/^[0-9A-F]{64}$/)
    expect(body.bundle.proof).toBeArray()

    const coins = await arena.player.token(arena.game.catalogue().coin.asset)
    expect(await coins.balance()).toBe(0)
    await arena.player.claims.add(body.bundle)
    expect(await coins.balance()).toBe(5)
  })

  forEachDoor('the catalogue is still open to anyone, because it is a price list', async (arena) => {
    const game: Game = arena.game
    expect(game.catalogue().coin.symbol).toBe('COIN')
  })
})
