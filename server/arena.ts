/**
 * The listener the room lives behind.
 *
 * `server/room.ts` is the room and knows nothing about sockets; this is the two
 * dozen lines that give it real ones. It is a second listener rather than a
 * path on the game server because Colyseus brings its own HTTP server for
 * matchmaking and its own WebSocket upgrade, and sharing one port with
 * `Bun.serve` would mean re-implementing both.
 *
 * Nothing about the trust boundary lives here. A socket that reaches this file
 * has proved nothing yet, and it stays that way until `ButtonRoom` says
 * otherwise.
 *
 * > Not to be confused with `worker/index.ts`'s `Arena`, which is the Durable
 * > Object holding the deployed demo's mock chain. That one is where the chain
 * > lives; this one is where the players are. The Worker runs no room at all.
 */

import { Server } from '@colyseus/core'
import { WebSocketTransport } from '@colyseus/ws-transport'

import type { ArenaPayload } from '../shared/catalogue.js'
import { createButtonRoom, observedPresses, type BankPresses } from './room.js'
import type { PressRegistry } from './presses.js'

/** The registered room type. The client asks for this name and no other. */
export const ARENA_ROOM = 'button'

export interface ArenaOptions {
  port: number
  /** The issuer's payout. The room is handed this and the client never names it. */
  bank: BankPresses
  /** Shared with anything else that spends presses; defaults to the process-wide one. */
  registry?: PressRegistry
  hostname?: string
}

export interface ArenaServer {
  /** Where a browser connects. Handed to the client through the catalogue. */
  url: string
  room: typeof ARENA_ROOM
  close(): Promise<void>
}

/**
 * Which way presses may be banked, decided once.
 *
 * The catalogue and the `/game/bank` route both read this, so "the room is
 * advertised" and "the HTTP route is closed" cannot come apart — they are one
 * answer read twice rather than two branches that agree today. Coming apart in
 * either direction is a bug with teeth: advertise a room and leave the route
 * open and the observed-press boundary is bypassable; close the route without
 * advertising a room and the game cannot bank at all.
 */
export interface BankingPolicy {
  /** Told to the client. Absent means single-player over `/game/bank`. */
  arena?: ArenaPayload
  /** What `/game/bank` refuses with, or null when it is the open path. */
  closed: string | null
}

export function bankingPolicy(arena: Pick<ArenaServer, 'url' | 'room'> | null): BankingPolicy {
  if (!arena) return { closed: null }
  return {
    arena: { url: arena.url, room: arena.room },
    closed:
      'This server banks through the button room, which counts the presses it saw. Connect to the arena, or restart with BUTTON_MULTIPLAYER=off for single-player.',
  }
}

export async function startArena(options: ArenaOptions): Promise<ArenaServer> {
  const server = new Server({
    transport: new WebSocketTransport(),
    greet: false,
    // Colyseus installs its own SIGINT/SIGTERM handling when this is on, which
    // would race `server/main.ts`'s. One owner for shutdown, and it is there.
    gracefullyShutdown: false,
  })

  server.define(
    ARENA_ROOM,
    createButtonRoom({
      bank: options.bank,
      registry: options.registry ?? observedPresses,
    }),
  )

  const hostname = options.hostname ?? 'localhost'
  await server.listen(options.port, hostname)

  return {
    url: `ws://${hostname}:${options.port}`,
    room: ARENA_ROOM,
    async close() {
      await server.gracefullyShutdown(false)
    },
  }
}
