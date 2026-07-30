/**
 * Button, on Cloudflare, at keicoin.org/examples/button.
 *
 * The claim on the front page is that a game economy needs no backend, and the
 * demonstration of that claim should be one click away (SPEC §10.4). So the same
 * three things `bun run dev` serves locally are served here: the mock node, the
 * issuer, and the client.
 *
 * The chain lives in **one Durable Object**, because a chain that differed per
 * request would not be a chain. That is also the honest shape of the thing: this
 * is a single-node mock, not a network, and a Durable Object is a single node.
 * When the object is evicted the chain resets, which the examples page says.
 *
 * The player's key never comes here. It is generated in their browser, kept in
 * their browser, and signs every block this Worker sees.
 */

import { DurableObject } from 'cloudflare:workers'
import { MockNode, mockRpcHandler, randomSeed } from 'kei-transaction'

import { GameError, startGame, type Game } from '../server/game.js'

interface Env {
  ASSETS: Fetcher
  ARENA: DurableObjectNamespace<Arena>
  /** Optional. Without it the issuer is new on every boot, which is fine here. */
  KEI_GAME_SEED?: string
  /** Set to 'off' to run the demo with payments disabled (SPEC §8). */
  BUTTON_EXCHANGE?: string
}

/** Everything under the mount point that is not a static file. */
const MOUNT = '/examples/button'

function apiPath(url: URL): string | null {
  const path = url.pathname.startsWith(MOUNT) ? url.pathname.slice(MOUNT.length) : url.pathname
  return path === '/rpc' || path.startsWith('/game/') ? path : null
}

export class Arena extends DurableObject<Env> {
  #booting: Promise<{ game: Game; rpc: (request: Request) => Promise<Response> }> | undefined

  /** One chain and one issuer, built on the first request and kept. */
  #ready(): Promise<{ game: Game; rpc: (request: Request) => Promise<Response> }> {
    this.#booting ??= (async () => {
      const node = await MockNode.create()
      const game = await startGame({
        seed: this.env.KEI_GAME_SEED ?? randomSeed(),
        node,
        network: 'mock',
        exchange: this.env.BUTTON_EXCHANGE !== 'off',
      })
      return { game, rpc: mockRpcHandler({ node }) }
    })()
    return this.#booting
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = apiPath(url)
    if (!path) return new Response('Not found', { status: 404 })

    const { game, rpc } = await this.#ready()

    if (path === '/rpc') return rpc(request)

    try {
      switch (path) {
        case '/game/catalogue':
          return json(game.catalogue())

        case '/game/bank': {
          const { address, presses } = await body<{ address: string; presses: number }>(request)
          return json({ bundle: await game.bank(address, presses) })
        }

        case '/game/order': {
          const { address, sku } = await body<{ address: string; sku: string }>(request)
          return json(await game.order(address, sku))
        }

        default:
          return new Response('Not found', { status: 404 })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: message }, error instanceof GameError ? 400 : 500)
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (apiPath(url)) {
      // One name, so every visitor shares one chain — which is what makes it a
      // chain rather than a save file.
      const arena = env.ARENA.get(env.ARENA.idFromName('button'))
      return arena.fetch(request)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    throw new GameError('That request was not JSON.')
  }
}
