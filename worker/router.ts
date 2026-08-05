/**
 * The deployed Worker's routing, with nothing Cloudflare-specific in it.
 *
 * Split out of `worker/index.ts` so a test can drive the exact code path a
 * request takes on `keicoin.org/examples/button` without a `workerd` in the
 * loop. What is left in `index.ts` is the Durable Object wrapper: boot a chain,
 * boot an issuer, keep them. Everything that reads a request is here, and
 * `test/api.test.ts` exercises it through the mounted URLs a browser really
 * sends.
 */

import { handleGameApi } from '../server/api.js'
import type { Game } from '../server/game.js'

/** Everything under the mount point that is not a static file. */
export const MOUNT = '/examples/button'

export function apiPath(url: URL): string | null {
  const path = url.pathname.startsWith(MOUNT) ? url.pathname.slice(MOUNT.length) : url.pathname
  return path === '/rpc' || path.startsWith('/game/') ? path : null
}

export async function handleArenaRequest(
  game: Game,
  rpc: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Response> {
  const path = apiPath(new URL(request.url))
  if (!path) return new Response('Not found', { status: 404 })
  if (path === '/rpc') return rpc(request)
  return (await handleGameApi(game, path, request)) ?? new Response('Not found', { status: 404 })
}
