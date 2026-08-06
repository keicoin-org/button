/** Exact M4 Button acceptance test. Set KEI_NODE_URL to a clean dev node RPC. */
import { afterEach, describe, expect, test } from 'bun:test'
import { Kei, randomSeed } from 'kei-transaction'
import { startGame, type Game } from '../server/game.js'
import { ORIGIN, bank, kill, open as openSession, press } from './support.js'

const nodeUrl = process.env.KEI_NODE_URL
const running: Array<{ close(): void }> = []
afterEach(() => {
  for (const closeable of running.splice(0)) closeable.close()
})

async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await condition()) return
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for ${what}.`)
}

describe.skipIf(!nodeUrl)('Button M4 over a native node', () => {
  test('mob claim funds an NPC purchase and the supply-one item lands on-chain', async () => {
    const game: Game = await startGame({
      seed: randomSeed(),
      node: nodeUrl!,
      network: 'testnet',
      flushMs: 20,
      pressRateCap: 100_000,
    })
    const player = await Kei.start({ seed: randomSeed(), node: nodeUrl!, network: 'testnet' })
    running.push(game, player)

    // A real rooted claim from a mob this server watched die.
    const session = await openSession(game, player)
    await player.claims.add((await game.loot(session, ORIGIN, kill(game, session, 'slime-1'))).bundle)
    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)
    expect(await coins.balance()).toBe(25)

    // Earn the remainder, pay the NPC, and ask the native holders index who owns it.
    const cap = catalogue.upgrades.find((upgrade) => upgrade.sku === 'cap')!
    expect(await (await player.token(cap.asset)).info()).toMatchObject({ maxSupply: '1' })
    press(game, session, cap.price)
    await player.claims.add(await bank(game, session))
    const order = await game.order(session, ORIGIN, cap.sku)
    await coins.transfer(order.to, order.price)
    await until(async () => (await player.items.owner(cap.asset)) === player.address, 'native item delivery')
    expect(await player.items.owner(cap.asset)).toBe(player.address)
  }, 60_000)
})
