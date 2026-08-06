/**
 * The node, as the public is allowed to reach it.
 *
 * `/rpc` is a public path — `keicoin.org/examples/button/rpc` on the deployed
 * Worker — because the browser half of this demo is a real wallet and a real
 * wallet talks to a node. It reads its own balance and publishes its own signed
 * blocks, and neither of those can go through the game server without making the
 * game server the thing that holds the money.
 *
 * What must not be public is the mock's **faucet**. `mockRpcHandler` dispatches
 * it with a caller-supplied amount, and `MockLedger.faucet` has no ceiling but
 * the community genesis allocation — so one unauthenticated POST mints a million
 * Kei, and a second turns that into COIN's entire max supply at the exchange
 * desk, after which every player's bank fails against the cap and the shared
 * demo is over (#30).
 *
 * So the node this exports answers reads and publishes, and mints nothing. A
 * starting balance is still given — it has to be, or a first-time visitor has an
 * empty wallet and no way to fill it — but it is given by the game, to a proven
 * address, in an amount this server decides. `Game.faucet` is that, and the
 * difference is the whole fix: the amount and the rate are the server's, never
 * the caller's.
 *
 * The list below is an allow-list rather than a deny-list on `faucet`, because
 * the two fail in opposite directions. A deny-list is correct until the SDK
 * gains another privileged action, and then it is silently wrong; an allow-list
 * refuses the new action until somebody looks at it. On a public mint the
 * failure that is merely inconvenient is the right one.
 */

import { mockRpcHandler, type KeiNode } from 'kei-transaction'

/**
 * Every action a wallet needs, and nothing that creates money.
 *
 * Reads, plus `process` — which publishes a block the *caller* signed, and is
 * therefore not a privilege this server is granting. Every one of these is
 * exercised by the browser in `src/economy.ts`; `faucet` never was, and the game
 * client has never passed an amount to it.
 */
export const PUBLIC_RPC_ACTIONS: readonly string[] = [
  'account_info',
  'account_history',
  'block_info',
  'accounts_receivable',
  'process',
  'work_thresholds',
  'asset_info',
  'asset_by_symbol',
  'account_holdings',
  'asset_balance',
  'asset_holders',
  'commit_info',
  'claim_status',
]

/**
 * The refusal, in the node's own shape.
 *
 * A Kei node answers errors at HTTP 200 with an `error` field, because that is
 * what Nano and Banano do and what ported tooling expects (SPEC §5.6.8). A 403
 * here would be this file inventing a second convention on one route.
 */
const REFUSED = 'This node does not mint. A starting balance comes from the game, at /game/faucet.'

/**
 * Wrap a node RPC handler so that only the public actions reach it.
 *
 * Nothing is trusted from the body except which action is named — the body is
 * passed on unread otherwise, so this cannot change the meaning of a call it
 * allows.
 */
export function guardRpc(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    // CORS preflight and the handler's own method refusals are its business.
    if (request.method !== 'POST') return handler(request)

    // Read once and rebuild, because a body can only be consumed once and the
    // handler needs the same bytes this decided on.
    const raw = await request.text()
    let action: unknown
    try {
      action = (JSON.parse(raw) as { action?: unknown }).action
    } catch {
      // Not JSON. The handler says so better than this could, and says it in the
      // shape the caller's client is expecting.
      action = undefined
    }

    if (typeof action === 'string' && !PUBLIC_RPC_ACTIONS.includes(action)) {
      return Response.json({ error: REFUSED }, { status: 200 })
    }

    return handler(
      new Request(request.url, { method: 'POST', headers: request.headers, body: raw }),
    )
  }
}

/**
 * The one place a public node surface is built.
 *
 * Both front doors call this rather than `mockRpcHandler`, for the same reason
 * both call `handleGameApi`: a boundary that is written out twice is a boundary
 * that gets closed once.
 */
export function publicNodeRpc(node: KeiNode): (request: Request) => Promise<Response> {
  return guardRpc(mockRpcHandler({ node }))
}
