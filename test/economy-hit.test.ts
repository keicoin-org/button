/**
 * The browser half of a kill, exercised for real.
 *
 * `test/sessions.test.ts` and `test/economy.test.ts` drive `game.hit`/`game.loot`
 * directly, which proves the server's own bookkeeping but nothing about what the
 * client does with the answer — and #25/#22 were exactly a bug in that
 * translation: `economy.hit()` returned `true` from its own catch block, so a
 * refused hit or a failed loot reported a kill that never happened, and
 * `src/main.ts` deletes the mesh on `true`.
 *
 * This calls `src/economy.ts`'s own `connect()` — the function `src/main.ts`
 * calls — against a real server on a real port, because that translation is
 * exactly what a test driving `game.hit` directly cannot see.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { MockNode, randomSeed, type Block, type KeiNode } from 'kei-transaction'

import { handleGameApi } from '../server/api.js'
import { publicNodeRpc } from '../server/rpc.js'
import { startGame, type Game } from '../server/game.js'
import type { Economy } from '../src/economy.js'

// `src/economy.ts` reads `location.pathname` at module load time — it is
// written for a browser, and normally the browser has already set `location`
// before any script runs. A `location` has to exist before the module is ever
// evaluated, which is earlier than any test body runs, so it is set here and
// the module is reached with a dynamic import rather than a static one — a
// static import is hoisted above this line regardless of where it is written.
;(globalThis as { location?: unknown }).location = { pathname: '/', origin: 'http://placeholder.invalid' }
const { connect } = await import('../src/economy.js')

const running: Array<{ close(): void }> = []
afterEach(() => {
  for (const closeable of running.splice(0)) closeable.close()
})

/**
 * The same chain, with the coin's own `DropBatch` commit refused — what a
 * failed drop looks like. `IssuerToken.commit` (`@keicoin/tokens`) publishes a
 * `kind: 'commit'` block, not a `mint` — a mint is `kei.items.mint`, for the
 * shop's items, and blocking that would not touch a bank or a loot at all.
 */
function nodeRefusingToCommitCoin(node: MockNode, asset: () => string | null): KeiNode {
  return Object.assign(Object.create(node) as MockNode, {
    async process(block: Block): Promise<{ hash: string }> {
      if (block.type === 'asset' && block.op.kind === 'commit' && block.op.asset === asset()) {
        throw new Error('over-supply: no units of this asset are left to mint')
      }
      return node.process(block)
    },
  })
}

/** A real `/rpc` + `/game/*` server, the same shape `server/main.ts` serves. */
function serve(game: Game, node: MockNode | KeiNode): { origin: string; close(): void } {
  const rpc = publicNodeRpc(node as KeiNode)
  const server = Bun.serve({
    port: 0,
    routes: {
      '/rpc': { POST: rpc, OPTIONS: rpc },
      '/game/*': async (request) => {
        const path = new URL(request.url).pathname
        return (await handleGameApi(game, path, request)) ?? new Response('Not found', { status: 404 })
      },
    },
  })
  return { origin: new URL(server.url).origin, close: () => void server.stop(true) }
}

const realFetch = globalThis.fetch

/**
 * `connect()` is written for a browser: `location.pathname` and `location.origin`
 * name where the page is served from, and every request is a path relative to
 * it. Both are given a real, if minimal, answer for the run of `body` — a plain
 * object for `location`, and a `fetch` that resolves a relative path against
 * this server's origin before handing it to the real `fetch`.
 */
async function browsingAt<T>(origin: string, body: () => Promise<T>): Promise<T> {
  const previousFetch = globalThis.fetch
  const previousLocation = (globalThis as { location?: unknown }).location
  ;(globalThis as { location?: unknown }).location = { pathname: '/', origin }
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' && input.startsWith('/') ? `${origin}${input}` : input
    return realFetch(url, init)
  }) as typeof fetch
  try {
    return await body()
  } finally {
    globalThis.fetch = previousFetch
    ;(globalThis as { location?: unknown }).location = previousLocation
  }
}

describe('a hit the server refuses', () => {
  test('is not reported as a kill, and the mob stays standing', async () => {
    // Zero burst: the very first observed request — the hit itself — finds an
    // empty bucket and is refused, the same shape as a player pressing and
    // clicking a slime at once (#25's real-world trigger).
    const node = await MockNode.create()
    const game = await startGame({ seed: randomSeed(), node, network: 'mock', flushMs: 20, pressBurst: 0 })
    const door = serve(game, node)
    running.push(game, door)

    let economy: Economy | undefined
    await browsingAt(door.origin, async () => {
      economy = await connect()
      // Contract stated at `EconomyState`'s `hit`: true only when the server
      // said it died and paid the drop. A refusal is neither.
      expect(await economy.hit('slime-1')).toBe(false)
    })
    economy?.close()
  }, 20_000)
})

describe('a kill whose drop failed to mint', () => {
  test('is not reported as a kill either, and the same event pays out once the mint works again', async () => {
    const node = await MockNode.create()
    // Blocked once the coin asset is known, below — the same seam
    // `test/economy.test.ts`'s refund tests use, aimed at the commit
    // `DropBatch.flush` makes rather than an item mint.
    let blockedAsset: string | null = null
    const game = await startGame({
      seed: randomSeed(),
      node: nodeRefusingToCommitCoin(node, () => blockedAsset),
      network: 'mock',
      flushMs: 20,
    })
    blockedAsset = game.catalogue().coin.asset
    const door = serve(game, node)
    running.push(game, door)

    let economy: Economy | undefined
    await browsingAt(door.origin, async () => {
      economy = await connect()

      // A slime takes three hits (`HITS_PER_MOB`). The first two are honestly
      // "still alive" — `false` because the mob is not dead yet, not because
      // anything failed. The third lands the kill and reaches `/game/loot`,
      // where the mint fails: `game.ts`'s `loot()` unredeems on exactly that
      // failure, so the mob is genuinely still uncollected server-side, and the
      // client is told the truth about that rather than reporting a kill that
      // did not happen.
      expect(await economy!.hit('slime-1')).toBe(false)
      expect(await economy!.hit('slime-1')).toBe(false)
      expect(await economy!.hit('slime-1')).toBe(false)

      // The server has already forgotten the specific event id; what it kept
      // is that this mob is still owed a payout (#31). A second click —
      // `economy.hit()` called again exactly as `src/main.ts` calls it on every
      // click — is the only handle a player has on that, and it must reach the
      // same kill rather than being refused as a fresh one.
      blockedAsset = null
      expect(await economy!.hit('slime-1')).toBe(true)
    })
    economy?.close()
  }, 20_000)
})
