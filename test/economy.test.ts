/**
 * The game's economy, without a browser.
 *
 * The world is Babylon and the world is not what can break the money. What can
 * break the money is what happens between a press and a balance, and all of that
 * is here: bank, claim, buy, deliver, and the arithmetic that decides what a
 * press was worth.
 *
 * Everything runs against the same in-memory chain the game runs against, so a
 * green suite here means the loop works, not that it was mocked.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Kei, MockNode, randomSeed } from 'kei-transaction'

import { payoutFor, upgradeBySku } from '../shared/catalogue.js'
import { GameError, pressAllowance, startGame, type Game, type PressBucket } from '../server/game.js'

const running: Array<{ close(): void }> = []

afterEach(() => {
  for (const closeable of running.splice(0)) closeable.close()
})

async function table(options: { exchange?: boolean; pressRateCap?: number } = {}): Promise<{
  game: Game
  player: Kei
  node: MockNode
}> {
  const node = await MockNode.create()
  const game = await startGame({
    seed: randomSeed(),
    node,
    network: 'mock',
    flushMs: 20,
    // A test that wants 400 coins should not have to spend sixteen seconds
    // earning them at a human rate. One test below uses the real ceiling.
    pressRateCap: options.pressRateCap ?? 100_000,
    ...(options.exchange === undefined ? {} : { exchange: options.exchange }),
  })
  const player = await Kei.start({ node, seed: randomSeed() })
  running.push(game, player)
  return { game, player, node }
}

/** Poll until true. Delivery is asynchronous by design — nothing here blocks a game loop. */
async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await condition()) return
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for ${what}.`)
}

describe('pressing', () => {
  test('banked presses become coins the player claims for themselves', async () => {
    const { game, player } = await table()
    const coins = await player.token(game.catalogue().coin.asset)

    const bundle = await game.bank(player.address, 12)
    expect(bundle.root).toMatch(/^[0-9A-F]{64}$/)

    await player.claims.add(bundle)
    expect(await coins.balance()).toBe(12)
  }, 20_000)

  test('one root covers every player who banked in the same window', async () => {
    const { game, node } = await table()
    const players = await Promise.all([
      Kei.start({ node, seed: randomSeed() }),
      Kei.start({ node, seed: randomSeed() }),
      Kei.start({ node, seed: randomSeed() }),
    ])
    running.push(...players)

    const bundles = await Promise.all(players.map((player, index) => game.bank(player.address, (index + 1) * 5)))
    expect(new Set(bundles.map((bundle) => bundle.root)).size).toBe(1)

    await Promise.all(players.map((player, index) => player.claims.add(bundles[index]!)))
    const coins = await players[0]!.token(game.catalogue().coin.asset)
    expect(await coins.balanceOf(players[0]!.address)).toBe(5)
    expect(await coins.balanceOf(players[2]!.address)).toBe(15)
  }, 20_000)

  test('two banks inside one window are one leaf, not two', async () => {
    const { game, player } = await table()
    const coins = await player.token(game.catalogue().coin.asset)

    const [first, second] = await Promise.all([game.bank(player.address, 4), game.bank(player.address, 6)])
    expect(first.root).toBe(second.root)
    expect(first.amount).toBe(second.amount)

    await player.claims.add(first)
    expect(await coins.balance()).toBe(10)
  }, 20_000)

  test('a client claiming a million presses gets a ceiling instead', async () => {
    const { game, player } = await table({ pressRateCap: 25 })
    const coins = await player.token(game.catalogue().coin.asset)

    await player.claims.add(await game.bank(player.address, 1_000_000))
    expect(await coins.balance()).toBeLessThan(200)
  }, 20_000)

  test('banking in a tight loop earns the rate, not the rate times the loop', async () => {
    const { game, player } = await table({ pressRateCap: 25 })

    // One call cannot tell a rate limit from a per-request cap, and a per-request
    // cap is what this used to be: it added a whole rateCap to every request and
    // subtracted nothing, so 200 requests a second bought 200 times the ceiling.
    // What a cap claims is a bound over time, so time is what has to be measured.
    const started = Date.now()
    let granted = 0
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        granted += Number((await game.bank(player.address, 1_000_000)).amount)
      } catch (error) {
        // Refused for being too fast, which is the ceiling holding rather than
        // failing. Anything else is a real fault and must not be swallowed into
        // a test that then passes for having banked nothing.
        if (!(error instanceof GameError)) throw error
      }
    }
    const seconds = (Date.now() - started) / 1_000

    // A full burst to start with, and the rate for as long as the loop ran. The
    // player owns nothing, so a press is worth one coin and `rate` is the cap.
    expect(granted).toBeLessThanOrEqual(25 * 4 + 25 * seconds)
    // And it is a ceiling, not a wall: the first honest batch is paid in full.
    expect(granted).toBeGreaterThanOrEqual(25 * 4)
  }, 60_000)

  test('zero presses is a sentence, not a block', async () => {
    const { game, player } = await table()
    await expect(game.bank(player.address, 0)).rejects.toThrow('That was zero presses.')
  }, 20_000)
})

describe('the shop', () => {
  test('the Golden Button Cap is a supply-one native item', async () => {
    const { game, player } = await table()
    const cap = game.catalogue().upgrades.find((upgrade) => upgrade.sku === 'cap')!
    expect((await (await player.token(cap.asset)).info()).maxSupply).toBe('1')
  }, 20_000)

  test('an upgrade is bought with a transfer and delivered as an item', async () => {
    const { game, player } = await table()
    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)
    const glove = catalogue.upgrades.find((upgrade) => upgrade.sku === 'glove')!

    await player.claims.add(await game.bank(player.address, 400))
    expect(await coins.balance()).toBeGreaterThanOrEqual(glove.price)

    const order = await game.order(player.address, 'glove')
    expect(order.price).toBe(upgradeBySku('glove')!.price)

    await coins.transfer(order.to, order.price)
    await until(async () => (await player.items.owner(glove.asset)) === player.address, 'the glove to arrive')

    // Which is the whole progression system: it is on the chain, not in a save file.
    expect((await player.items.ownedBy()).map((item) => item.name)).toContain('Springy Glove')
  }, 30_000)

  test('an upgrade changes what the next press is worth, read off the chain', async () => {
    const { game, player } = await table()
    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)
    const knuckle = catalogue.upgrades.find((upgrade) => upgrade.sku === 'knuckle')!

    await player.claims.add(await game.bank(player.address, 400))
    const order = await game.order(player.address, 'knuckle')
    await coins.transfer(order.to, order.price)
    await until(async () => (await player.items.owner(knuckle.asset)) === player.address, 'the knuckle to arrive')

    const before = await coins.balance()
    await player.claims.add(await game.bank(player.address, 10))
    // +4 a press, and the server worked that out by reading the player's holdings.
    expect((await coins.balance()) - before).toBe(50)
  }, 30_000)

  test('coins spent in the shop are burned, not banked', async () => {
    const { game, player } = await table()
    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)
    const glove = catalogue.upgrades.find((upgrade) => upgrade.sku === 'glove')!

    await player.claims.add(await game.bank(player.address, 400))
    const supplyBefore = Number((await coins.info()).circulating)

    const order = await game.order(player.address, 'glove')
    await coins.transfer(order.to, order.price)
    await until(async () => (await player.items.owner(glove.asset)) === player.address, 'the glove to arrive')
    await until(async () => Number((await coins.info()).circulating) < supplyBefore, 'the coins to be burned')

    expect(Number((await coins.info()).circulating)).toBe(supplyBefore - order.price)
  }, 30_000)

  test('buying what you cannot afford says the price and the balance', async () => {
    const { game, player } = await table()
    await expect(game.order(player.address, 'cap')).rejects.toThrow(
      'Golden Button Cap costs 6000 coins and you have 0. Press the button a few more times.',
    )
  }, 20_000)

  test('the shop does not sell things it does not sell', async () => {
    const { game, player } = await table()
    await expect(game.order(player.address, 'a-second-house')).rejects.toThrow('does not sell "a-second-house"')
  }, 20_000)
})

describe('mob loot', () => {
  test('a defeated mob drops a claim the player writes on their own chain', async () => {
    const { game, player } = await table()
    const coins = await player.token(game.catalogue().coin.asset)
    const bundle = await game.loot(player.address, 'slime-1')
    expect(bundle.root).toMatch(/^[0-9A-F]{64}$/)
    await player.claims.add(bundle)
    expect(await coins.balance()).toBe(25)
  }, 20_000)

  test('a retry returns the same entitlement instead of duplicating the drop', async () => {
    const { game, player } = await table()
    const [first, retry] = await Promise.all([
      game.loot(player.address, 'slime-2'),
      game.loot(player.address, 'slime-2'),
    ])
    expect(retry).toEqual(first)
  }, 20_000)
})

describe('the exchange desk', () => {
  test('paying Kei mints coins at the posted rate', async () => {
    const { game, player } = await table()
    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)

    await player.faucet(1)
    await player.pay({ to: game.address, amount: 0.25 })
    await until(async () => (await coins.balance()) > 0, 'the coins to be minted')

    expect(await coins.balance()).toBe(250)
  }, 30_000)

  test('with the desk off, Kei buys nothing and the game still works', async () => {
    const { game, player } = await table({ exchange: false })
    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)
    expect(catalogue.exchange.open).toBe(false)

    await player.faucet(1)
    await player.pay({ to: game.address, amount: 0.25 })
    await Bun.sleep(200)
    expect(await coins.balance()).toBe(0)

    // The loop that matters is untouched: pressing still pays (SPEC §8).
    await player.claims.add(await game.bank(player.address, 9))
    expect(await coins.balance()).toBe(9)
  }, 30_000)
})

describe('the press rate ceiling', () => {
  const rate = 25
  const burst = rate * 4

  test('an address nobody has seen starts with the burst and no more', () => {
    const spent = pressAllowance(undefined, 1_000_000, 1_000, rate, burst)
    expect(spent.counted).toBe(100)
    expect(spent.bucket.budget).toBe(0)
  })

  test('a request earns nothing for being a request', () => {
    // The defect as arithmetic: two requests 4 ms apart each used to get a whole
    // rateCap on top of whatever elapsed time earned, so the ceiling went up when
    // the caller sped up.
    const first = pressAllowance(undefined, 1_000_000, 1_000, rate, burst)
    const second = pressAllowance(first.bucket, 1_000_000, 1_004, rate, burst)
    expect(second.counted).toBe(0)
    // 4 ms at 25 a second is a tenth of a press, and it stays in the bucket
    // rather than being rounded up to a grant.
    expect(second.bucket.budget).toBeCloseTo(0.1)
  })

  test('elapsed time refills at the rate, and the burst is the ceiling', () => {
    const empty: PressBucket = { budget: 0, at: 0 }
    expect(pressAllowance(empty, 1_000_000, 2_000, rate, burst).counted).toBe(50)
    expect(pressAllowance(empty, 1_000_000, 4_000, rate, burst).counted).toBe(100)
    // An hour idle is still 100. Idling banks nothing past the burst, which is
    // the half create-kei-game#42 is missing.
    expect(pressAllowance(empty, 1_000_000, 3_600_000, rate, burst).counted).toBe(100)
  })

  test('what is counted comes out of the budget, so the rest is still there', () => {
    const spent = pressAllowance({ budget: 40, at: 0 }, 12, 0, rate, burst)
    expect(spent.counted).toBe(12)
    expect(spent.bucket.budget).toBe(28)
  })

  test('a player whose machines press faster than a hand is not clipped for it', () => {
    // Nine Auto-Pressers Mk II press 27 times a second, which is more than the
    // 25 a finger is allowed. They are items on the chain, so the rate counts
    // them — otherwise the cap would take earnings off the players who paid for
    // the upgrade that produces them.
    const owned = payoutFor({ 'auto-mk2': 9 })
    expect(owned.pressesPerSecond).toBe(27)

    const machines = rate + owned.pressesPerSecond
    const spent = pressAllowance({ budget: 0, at: 0 }, 27, 1_000, machines, machines * 4)
    expect(spent.counted).toBe(27)
  })
})

describe('the price list', () => {
  test('an empty wallet earns one coin a press and nothing automatic', () => {
    expect(payoutFor({})).toEqual({ perPress: 1, pressesPerSecond: 0 })
  })

  test('upgrades stack per copy, and the cap doubles the lot', () => {
    expect(payoutFor({ glove: 3 }).perPress).toBe(4)
    expect(payoutFor({ knuckle: 2 }).perPress).toBe(9)
    expect(payoutFor({ glove: 1, cap: 1 }).perPress).toBe(4)
    expect(payoutFor({ 'auto-mk1': 2, 'auto-mk2': 1 }).pressesPerSecond).toBe(5)
  })
})
