/**
 * The bits every suite here needs: a game, a player, and a proven session.
 *
 * `play()` is deliberately the *honest* path — it signs a real challenge with a
 * real key and presses one request at a time — because a helper that reached
 * past the boundary would make every test above it prove nothing.
 */

import { Kei, MockNode, randomSeed } from 'kei-transaction'

import { startGame, type Game } from '../server/game.js'
import { sign } from '../src/ownership.js'

export const ORIGIN = 'http://localhost:7777'

export interface Table {
  game: Game
  player: Kei
  node: MockNode
  seed: string
}

export async function table(
  options: { exchange?: boolean; pressRateCap?: number; pressBurst?: number } = {},
): Promise<Table & { close(): void }> {
  const node = await MockNode.create()
  const game = await startGame({
    seed: randomSeed(),
    node,
    network: 'mock',
    flushMs: 20,
    // A test that wants 400 coins should not spend sixteen seconds earning them
    // at a human rate. The tests that are *about* the ceiling set a real one.
    pressRateCap: options.pressRateCap ?? 100_000,
    ...(options.pressBurst === undefined ? {} : { pressBurst: options.pressBurst }),
    ...(options.exchange === undefined ? {} : { exchange: options.exchange }),
  })
  const seed = randomSeed()
  const player = await Kei.start({ node, seed })
  return {
    game,
    player,
    node,
    seed,
    close() {
      game.close()
      player.close()
    },
  }
}

export async function join(node: MockNode): Promise<{ player: Kei; seed: string }> {
  const seed = randomSeed()
  return { player: await Kei.start({ node, seed }), seed }
}

/** Prove an address the way the browser does, and get the session id back. */
export async function open(game: Game, player: Kei, origin = ORIGIN): Promise<string> {
  const challenge = game.challenge(player.address, origin)
  const proof = await sign(player, challenge)
  return (await game.authenticate(proof, origin)).id
}

/** Press `times` times, one observed request each, exactly as the client does. */
export function press(game: Game, session: string, times: number, origin = ORIGIN): void {
  for (let index = 0; index < times; index++) game.press(session, origin)
}

/** A whole slime, hit until this server says it is dead. Returns the event id. */
export function kill(game: Game, session: string, mob: string, origin = ORIGIN): string {
  for (;;) {
    const blow = game.hit(session, origin, mob)
    if (blow.event) return blow.event
  }
}

/** Poll until true. Delivery is asynchronous by design — nothing blocks a game loop. */
export async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await condition()) return
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for ${what}.`)
}
