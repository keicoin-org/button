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
import { MockNode, randomSeed } from 'kei-transaction'

import { publicNodeRpc } from '../server/rpc.js'
import { startGame, type Game } from '../server/game.js'
import { apiPath, handleArenaRequest } from './router.js'

interface Env {
  ASSETS: Fetcher
  ARENA: DurableObjectNamespace<Arena>
  /** Optional. Without it the issuer is new on every boot, which is fine here. */
  KEI_GAME_SEED?: string
  /** Set to 'off' to run the demo with payments disabled (SPEC §8). */
  BUTTON_EXCHANGE?: string
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
      // Guarded, because this one is genuinely public: `/examples/button/rpc`
      // is reachable by anybody, and the mock's faucet takes its amount from the
      // request body (#30). A wallet's reads and its own signed blocks go
      // through; a mint does not.
      return { game, rpc: publicNodeRpc(node) }
    })()
    return this.#booting
  }

  override async fetch(request: Request): Promise<Response> {
    const { game, rpc } = await this.#ready()
    return handleArenaRequest(game, rpc, request)
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
