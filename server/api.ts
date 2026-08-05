/**
 * The `/game/*` surface, written once.
 *
 * `bun run dev` and the deployed Cloudflare Worker are two processes with two
 * transports, and before this file they were also two copies of the same routing
 * — which is how `worker/index.ts` came to expose the identical trust boundary
 * the Bun server did. One dispatcher means a boundary cannot be closed in one
 * deployment and left open in the other, and `test/api.test.ts` drives both
 * entry points through their own front doors to say so.
 *
 * Nothing here decides anything. It reads JSON, hands the pieces to
 * `server/game.ts`, and turns a thrown sentence into a status code.
 */

import { GameError } from './errors.js'
import type { Game } from './game.js'

/** Where a request came from, as a session is bound to it. */
export function originOf(request: Request): string {
  // Browsers send `Origin` on every one of these — they all carry a JSON
  // content type, so none of them is a simple request. A caller that is not a
  // browser can of course leave it off or write anything into it, which is why
  // origin binding is scoped in the README to what it actually stops: another
  // *page* silently reusing a session that leaked to it.
  const header = request.headers.get('origin')
  if (header && header !== 'null') return header
  return new URL(request.url).origin
}

/**
 * Answer one `/game/*` request, or return `null` if the path is not one of them.
 *
 * `path` is already mount-relative: `/game/bank`, never
 * `/examples/button/game/bank`.
 */
export async function handleGameApi(game: Game, path: string, request: Request): Promise<Response | null> {
  if (!path.startsWith('/game/')) return null

  const origin = originOf(request)
  try {
    switch (path) {
      case '/game/catalogue':
        return json(game.catalogue())

      case '/game/session/challenge': {
        const { address } = await body<{ address: unknown }>(request)
        return json({ challenge: game.challenge(String(address ?? ''), origin) })
      }

      case '/game/session': {
        const { proof } = await body<{ proof: unknown }>(request)
        const session = await game.authenticate(proof, origin)
        // The address is echoed back as this server understands it, so a client
        // can notice at once if it proved something other than what it meant to.
        return json({ session: session.id, address: session.address, room: game.room })
      }

      case '/game/press': {
        const { session } = await body<{ session: unknown }>(request)
        return json(game.press(session, origin))
      }

      case '/game/hit': {
        const { session, mob } = await body<{ session: unknown; mob: unknown }>(request)
        return json(game.hit(session, origin, mob))
      }

      case '/game/bank': {
        // `batch` is the client's name for this attempt, and the only field in
        // the whole surface a caller invents. It buys nothing — it says which
        // payout is being asked for, so asking twice cannot buy two.
        const { session, batch } = await body<{ session: unknown; batch: unknown }>(request)
        return json({ bundle: await game.bank(session, origin, batch) })
      }

      case '/game/loot': {
        const { session, event } = await body<{ session: unknown; event: unknown }>(request)
        return json({ bundle: await game.loot(session, origin, event) })
      }

      case '/game/order': {
        const { session, sku } = await body<{ session: unknown; sku: unknown }>(request)
        return json(await game.order(session, origin, String(sku ?? '')))
      }

      case '/game/purchases': {
        // How the last few purchases ended. Read-only, and answered to the
        // proven wallet only — it is a list of what somebody bought.
        const { session } = await body<{ session: unknown }>(request)
        return json({ purchases: game.purchases(session, origin) })
      }

      default:
        return null
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return json({ error: message }, error instanceof GameError ? 400 : 500)
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

async function body<T>(request: Request): Promise<T> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    throw new GameError('That request was not JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GameError('That request body was not a JSON object.')
  }
  return parsed as T
}
