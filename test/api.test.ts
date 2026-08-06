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
import { HttpNode, Kei } from 'kei-transaction'

import { handleGameApi } from '../server/api.js'
import { publicNodeRpc } from '../server/rpc.js'
import { handleArenaRequest } from '../worker/router.js'
import type { Game } from '../server/game.js'
import { sign } from '../src/ownership.js'
import { batchId, table, until, type Table } from './support.js'

const running: Array<{ close(): void }> = []
afterEach(() => {
  for (const closeable of running.splice(0)) closeable.close()
})

/** Post to a game, however that game is reached. */
type Door = (path: string, body: unknown, origin?: string) => Promise<{ status: number; body: any }>

interface Arena extends Table {
  door: Door
  origin: string
  /** A `fetch` that reaches this door's `/rpc`, so a real wallet can be pointed at it. */
  fetchRpc: typeof globalThis.fetch
}

/** `bun run dev`: a real listener, reached over the network. */
async function bunDoor(options: Parameters<typeof table>[0] = {}): Promise<Arena> {
  const built = await table(options)
  // The node is mounted the way `server/main.ts` mounts it, because `/rpc` is a
  // public path and what is reachable on it is the subject of #30.
  const rpc = publicNodeRpc(built.node)
  const server = Bun.serve({
    port: 0,
    routes: {
      '/rpc': { POST: rpc, OPTIONS: rpc },
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
    fetchRpc: globalThis.fetch,
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
  // The handler `worker/index.ts` builds, not a stand-in: `/examples/button/rpc`
  // is served to the public and what it will answer is the point of these tests.
  const rpc = publicNodeRpc(built.node)

  return {
    ...built,
    origin,
    // The Worker has no listener, so a wallet reaches it the way every other
    // request in this file does: through `handleArenaRequest` itself.
    fetchRpc: Object.assign(
      (input: URL | RequestInfo, init?: RequestInit): Promise<Response> =>
        handleArenaRequest(built.game, rpc, new Request(input as string, init)),
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch,
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
      batch: batchId(),
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
    const { body } = await arena.door('/game/bank', { session, batch: batchId(), address: victim })
    const coins = await arena.player.token(arena.game.catalogue().coin.asset)
    await arena.player.claims.add(body.bundle)
    expect(await coins.balance()).toBe(4)
    expect(await coins.balanceOf(victim)).toBe(0)
  })
})

describe('a bank names its batch', () => {
  forEachDoor('the same batch id twice is answered with the same proof', async (arena) => {
    const session = await authenticate(arena)
    await pressThrough(arena, session, 6)

    const batch = batchId()
    // The first answer is signed and then lost on the way back. The client has
    // no proof and cannot tell that from a request that never arrived, so it
    // sends the batch again.
    const lost = await arena.door('/game/bank', { session, batch })
    const recovered = await arena.door('/game/bank', { session, batch })

    expect(recovered.status).toBe(200)
    expect(recovered.body.bundle.root).toBe(lost.body.bundle.root)

    await arena.player.claims.add(recovered.body.bundle)
    const coins = await arena.player.token(arena.game.catalogue().coin.asset)
    expect(await coins.balance()).toBe(6)
  })

  forEachDoor('a bank with no batch id is refused, and the presses survive it', async (arena) => {
    const session = await authenticate(arena)
    await pressThrough(arena, session, 4)

    const { status, body } = await arena.door('/game/bank', { session })
    expect(status).toBe(400)
    expect(body.bundle).toBeUndefined()
    expect(body.error).toMatch(/batch id/)

    // Refused before the tally was touched, so the presses are still owed.
    const { body: paid } = await arena.door('/game/bank', { session, batch: batchId() })
    await arena.player.claims.add(paid.bundle)
    const coins = await arena.player.token(arena.game.catalogue().coin.asset)
    expect(await coins.balance()).toBe(4)
  })
})

/**
 * `/rpc` is public, and what it will do for a stranger.
 *
 * The browser half of this demo is a real wallet, so the node has to be
 * reachable from the page: it reads its own balance and publishes its own signed
 * blocks, and neither can go through the game server without making the game
 * server the thing that holds the money. What must not be reachable is the
 * mock's faucet, which took its amount from the request body — two POSTs minted
 * a million Kei and turned it into COIN's whole max supply at the exchange desk,
 * after which every player's bank fails against the cap (#30).
 *
 * These run against the real handler both doors serve, at the mounted URL the
 * deployed Worker answers on.
 */
describe('the public node does not mint', () => {
  forEachDoor('the faucet action is refused, whatever amount it names', async (arena) => {
    const thief = (await keyPairFromSeed(randomSeed(), 0)).address

    // Issue #30's first curl, verbatim: 10^24 raw is 1,000,000 Kei.
    const { body } = await arena.door('/rpc', {
      action: 'faucet',
      account: thief,
      amount: '1000000000000000000000000',
    })
    expect(body.hash).toBeUndefined()
    expect(body.error).toMatch(/does not mint/)

    // Nothing was minted, so the second step of the scenario has nothing to
    // spend: no Kei, therefore no top-up, therefore no run at COIN's cap.
    const account = await arena.node.accountInfo(thief)
    expect(account === null || BigInt(account.balance) === 0n).toBe(true)
  })

  forEachDoor('an amountless faucet call is refused too, not merely a capped one', async (arena) => {
    const thief = (await keyPairFromSeed(randomSeed(), 0)).address
    const { body } = await arena.door('/rpc', { action: 'faucet', account: thief })
    expect(body.error).toMatch(/does not mint/)
    expect(await arena.node.accountInfo(thief)).toBe(null)
  })

  forEachDoor('an action this node has never heard of is refused rather than tried', async (arena) => {
    // The allow-list's real job: it is not a list of known-bad actions, so an
    // action added to the SDK later is refused until somebody has looked at it.
    const { body } = await arena.door('/rpc', { action: 'mint_everything', account: arena.player.address })
    expect(body.error).toMatch(/does not mint/)
  })

  forEachDoor('a wallet can still read and still publish, which is the whole point', async (arena) => {
    const { body: info } = await arena.door('/rpc', { action: 'account_info', account: arena.player.address })
    expect(info.error).toBeUndefined()
    expect(info).toHaveProperty('account')

    // A whole wallet over the guarded surface: `HttpNode` speaks docs/rpc.md and
    // this points it at the same handler the browser reaches. If the guard broke
    // reads or `process`, none of this would get off the ground.
    const player = await Kei.start({
      node: new HttpNode({ url: `${arena.origin}/rpc`, network: 'mock', fetch: arena.fetchRpc }),
      seed: randomSeed(),
    })
    running.push({ close: () => player.close() })

    const session = await authenticate({ ...arena, player } as Arena)
    for (let press = 0; press < 5; press++) await arena.door('/game/press', { session })
    const { body: banked } = await arena.door('/game/bank', { session, batch: batchId() })
    await player.claims.add(banked.bundle)

    const coins = await player.token(arena.game.catalogue().coin.asset)
    expect(await coins.balance()).toBe(5)
  })
})

describe('a starting balance comes from the game', () => {
  forEachDoor('a proven wallet is granted a fixed amount it cannot state', async (arena) => {
    const session = await authenticate(arena)

    // No amount in the body, and one in it changes nothing.
    const { status, body } = await arena.door('/game/faucet', { session, amount: '1000000', kei: 1_000_000 })
    expect(status).toBe(200)
    expect(body.granted).toBe(10)

    // Ten, and ten however loudly the body asked for a million. The wallet
    // collects it the way it collects anything else sent to it.
    await until(async () => (await arena.player.balance()) === 10, 'the grant to be collected')
  })

  forEachDoor('a second grant to the same wallet is refused', async (arena) => {
    const session = await authenticate(arena)
    await arena.door('/game/faucet', { session })

    const { status, body } = await arena.door('/game/faucet', { session })
    expect(status).toBe(400)
    expect(body.error).toMatch(/one grant an hour/)
  })

  forEachDoor('a grant needs a session, so it is not a mint by URL', async (arena) => {
    const { status, body } = await arena.door('/game/faucet', { address: arena.player.address })
    expect(status).toBe(400)
    expect(body.error).toMatch(/Prove your address/)
  })
})

describe('the shop answers for itself', () => {
  forEachDoor('a purchase can be followed to its ending through the door', async (arena) => {
    const session = await authenticate(arena)
    await pressThrough(arena, session, 30)
    const { body: paid } = await arena.door('/game/bank', { session, batch: batchId() })
    await arena.player.claims.add(paid.bundle)

    const { body: order } = await arena.door('/game/order', { session, sku: 'glove' })
    expect(order.id).toBeString()

    const open = await arena.door('/game/purchases', { session })
    expect(open.body.purchases.at(-1)).toMatchObject({ id: order.id, state: 'open' })

    const coins = await arena.player.token(arena.game.catalogue().coin.asset)
    await coins.transfer(order.to, order.price)

    // The transfer is the player's and the delivery is the issuer's, so the only
    // way this browser learns how it ended is by asking.
    let settled: { state?: string; item?: string } = {}
    for (let attempt = 0; attempt < 40 && settled.state !== 'delivered'; attempt++) {
      await Bun.sleep(50)
      const { body } = await arena.door('/game/purchases', { session })
      settled = body.purchases.find((receipt: { id: string }) => receipt.id === order.id) ?? {}
    }
    expect(settled).toMatchObject({ state: 'delivered', item: 'Springy Glove' })
  })

  forEachDoor('receipts need a session, because they are about somebody’s money', async (arena) => {
    const { status, body } = await arena.door('/game/purchases', {})
    expect(status).toBe(400)
    expect(body.purchases).toBeUndefined()
    expect(body.error).toMatch(/Prove your address/)
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

    const banks = await Promise.all(
      Array.from({ length: 20 }, () => arena.door('/game/bank', { session, batch: batchId() })),
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
      const started = Date.now()
      const results = await Promise.all(
        Array.from({ length: 400 }, () => arena.door('/game/press', { session })),
      )
      const elapsed = Date.now() - started
      const watched = results.filter((result) => result.status === 200).length

      // The bound is the ceiling's own arithmetic — a full burst, plus what
      // refills while the flood is in the air — rather than a figure that only
      // holds while the flood happens to take under a second. A slow machine
      // makes the flood longer, and a longer flood legitimately allows more.
      expect(watched).toBeLessThanOrEqual(10 + Math.ceil((elapsed / 1_000) * 5))
      expect(watched).toBeGreaterThanOrEqual(10)

      const { body } = await arena.door('/game/bank', { session, batch: batchId() })
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

    const { body } = await arena.door('/game/bank', { session, batch: batchId() })
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
