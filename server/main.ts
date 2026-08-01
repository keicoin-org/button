/**
 * `bun run dev` — the whole game, one process.
 *
 * Three things live here and only one of them is the game:
 *
 *   /rpc      a Kei node. In-memory, and a development tool (M2 is the real
 *             node; M3 points this URL at it and nothing above it changes).
 *   /game/*   the issuer, which is `server/game.ts`.
 *   /         the client, bundled on startup.
 *
 * They are one process because it is one `bun run dev`, not because they belong
 * together. The player's browser reaches the node directly and signs everything
 * it writes; this server never sees a player's key and cannot move their money.
 */

import { MockNode, mockRpcHandler, randomSeed } from 'kei-transaction'

import { GameError, startGame } from './game.js'

/** Native, and with a trailing separator — `pathname` would hand Windows `/C:/…`. */
const root = Bun.fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.PORT ?? 7777)
const exchange = process.env.BUTTON_EXCHANGE !== 'off'

const bundle = await Bun.build({
  entrypoints: [`${root}src/main.ts`],
  outdir: `${root}public/build`,
  target: 'browser',
  sourcemap: 'linked',
})
if (!bundle.success) {
  for (const log of bundle.logs) console.error(log)
  process.exit(1)
}

// A fresh chain every run, because it is in memory. The player's wallet lives in
// their browser and outlives it, which just means they come back to an empty
// account on a new chain — the honest behaviour for a mock.
const node = await MockNode.create()
const rpc = mockRpcHandler({ node })

const game = await startGame({
  seed: process.env.KEI_GAME_SEED ?? randomSeed(),
  node,
  network: 'mock',
  exchange,
})

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { 'access-control-allow-origin': '*' } })

const failed = (error: unknown): Response =>
  json({ error: error instanceof Error ? error.message : String(error) }, error instanceof GameError ? 400 : 500)

async function read<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    throw new GameError('That request was not JSON.')
  }
}

const server = Bun.serve({
  port,
  routes: {
    '/': () => new Response(Bun.file(`${root}index.html`), { headers: { 'content-type': 'text/html' } }),

    '/favicon.ico': () =>
      new Response(Bun.file(`${root}public/favicon.ico`), { headers: { 'content-type': 'image/x-icon' } }),

    '/build/*': (request) => {
      // Only what the bundler wrote, and only by name — no path walking.
      const name = new URL(request.url).pathname.slice('/build/'.length)
      if (!/^[\w.-]+$/.test(name)) return new Response('Not found', { status: 404 })
      // The bundle is rebuilt on every start, so a cached one is always the
      // wrong one.
      return new Response(Bun.file(`${root}public/build/${name}`), { headers: { 'cache-control': 'no-store' } })
    },

    '/rpc': { POST: rpc, OPTIONS: rpc },

    '/game/catalogue': () => json(game.catalogue()),

    '/game/bank': {
      async POST(request) {
        try {
          const { address, presses } = await read<{ address: string; presses: number }>(request)
          return json({ bundle: await game.bank(address, presses) })
        } catch (error) {
          return failed(error)
        }
      },
    },

    '/game/order': {
      async POST(request) {
        try {
          const { address, sku } = await read<{ address: string; sku: string }>(request)
          return json(await game.order(address, sku))
        } catch (error) {
          return failed(error)
        }
      },
    },

    '/game/loot': {
      async POST(request) {
        try {
          const { address, mob } = await read<{ address: string; mob: string }>(request)
          return json({ bundle: await game.loot(address, mob) })
        } catch (error) {
          return failed(error)
        }
      },
    },
  },
})

console.log(`
  Button — press it.

  play          ${server.url}
  node (mock)   ${server.url}rpc
  issuer        ${game.address}
  exchange      ${exchange ? 'on, 1 Kei = 1,000 coins' : 'off (BUTTON_EXCHANGE=off)'}

  This chain is in memory and dies with this process. Nothing here is worth
  anything, which is the point of M1.
`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    game.close()
    void server.stop(true).then(() => process.exit(0))
  })
}
