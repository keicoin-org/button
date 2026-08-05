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
import type { ClaimBundle } from 'kei-transaction'

import { payoutFor, upgradeBySku } from '../shared/catalogue.js'
import { ORIGIN, join, kill, open, press, table as freshTable, until } from './support.js'

const running: Array<{ close(): void }> = []

afterEach(() => {
  for (const closeable of running.splice(0)) closeable.close()
})

/**
 * A game, a player, and a session that player proved.
 *
 * Every test below goes through the same door the browser does. Nothing here
 * can hand the game an address or a press count, because the game no longer has
 * a way to be handed one.
 */
async function table(options: { exchange?: boolean; pressRateCap?: number } = {}) {
  const built = await freshTable(options)
  running.push(built)
  return { ...built, session: await open(built.game, built.player) }
}

describe('pressing', () => {
  test('banked presses become coins the player claims for themselves', async () => {
    const { game, player, session } = await table()
    const coins = await player.token(game.catalogue().coin.asset)

    press(game, session, 12)
    const bundle = await game.bank(session, ORIGIN)
    expect(bundle.root).toMatch(/^[0-9A-F]{64}$/)

    await player.claims.add(bundle)
    expect(await coins.balance()).toBe(12)
  }, 20_000)

  test('one root covers every player who banked in the same window', async () => {
    const { game, node } = await table()
    const joined = await Promise.all([join(node), join(node), join(node)])
    const players = joined.map((entry) => entry.player)
    running.push(...players)

    const sessions = await Promise.all(players.map((player) => open(game, player)))
    sessions.forEach((session, index) => press(game, session, (index + 1) * 5))

    const bundles = await Promise.all(sessions.map((session) => game.bank(session, ORIGIN)))
    expect(new Set(bundles.map((bundle) => bundle.root)).size).toBe(1)

    await Promise.all(players.map((player, index) => player.claims.add(bundles[index]!)))
    const coins = await players[0]!.token(game.catalogue().coin.asset)
    expect(await coins.balanceOf(players[0]!.address)).toBe(5)
    expect(await coins.balanceOf(players[2]!.address)).toBe(15)
  }, 20_000)

  test('two banks in flight divide one tally instead of both selling it', async () => {
    const { game, player, session } = await table()
    const coins = await player.token(game.catalogue().coin.asset)

    press(game, session, 10)
    // The tally is taken synchronously, so the first bank takes all ten and the
    // second finds nothing left. A second leaf here would be the same presses
    // paid for twice.
    const [first, second] = await Promise.allSettled([game.bank(session, ORIGIN), game.bank(session, ORIGIN)])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')

    await player.claims.add((first as PromiseFulfilledResult<ClaimBundle>).value)
    expect(await coins.balance()).toBe(10)
  }, 20_000)

  test('banking before this server watched anything is a sentence, not a block', async () => {
    const { game, session } = await table()
    await expect(game.bank(session, ORIGIN)).rejects.toThrow('has not seen any presses from you yet')
  }, 20_000)
})

describe('the shop', () => {
  test('the Golden Button Cap is a supply-one native item', async () => {
    const { game, player } = await table()
    const cap = game.catalogue().upgrades.find((upgrade) => upgrade.sku === 'cap')!
    expect((await (await player.token(cap.asset)).info()).maxSupply).toBe('1')
  }, 20_000)

  test('an upgrade is bought with a transfer and delivered as an item', async () => {
    const { game, player, session } = await table()
    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)
    const glove = catalogue.upgrades.find((upgrade) => upgrade.sku === 'glove')!

    press(game, session, 400)
    await player.claims.add(await game.bank(session, ORIGIN))
    expect(await coins.balance()).toBeGreaterThanOrEqual(glove.price)

    const order = await game.order(session, ORIGIN, 'glove')
    expect(order.price).toBe(upgradeBySku('glove')!.price)

    await coins.transfer(order.to, order.price)
    await until(async () => (await player.items.owner(glove.asset)) === player.address, 'the glove to arrive')

    // Which is the whole progression system: it is on the chain, not in a save file.
    expect((await player.items.ownedBy()).map((item) => item.name)).toContain('Springy Glove')
  }, 30_000)

  test('an upgrade changes what the next press is worth, read off the chain', async () => {
    const { game, player, session } = await table()
    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)
    const knuckle = catalogue.upgrades.find((upgrade) => upgrade.sku === 'knuckle')!

    press(game, session, 400)
    await player.claims.add(await game.bank(session, ORIGIN))
    const order = await game.order(session, ORIGIN, 'knuckle')
    await coins.transfer(order.to, order.price)
    await until(async () => (await player.items.owner(knuckle.asset)) === player.address, 'the knuckle to arrive')

    const before = await coins.balance()
    press(game, session, 10)
    await player.claims.add(await game.bank(session, ORIGIN))
    // +4 a press, and the server worked that out by reading the player's holdings.
    expect((await coins.balance()) - before).toBe(50)
  }, 30_000)

  test('coins spent in the shop are burned, not banked', async () => {
    const { game, player, session } = await table()
    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)
    const glove = catalogue.upgrades.find((upgrade) => upgrade.sku === 'glove')!

    press(game, session, 400)
    await player.claims.add(await game.bank(session, ORIGIN))
    const supplyBefore = Number((await coins.info()).circulating)

    const order = await game.order(session, ORIGIN, 'glove')
    await coins.transfer(order.to, order.price)
    await until(async () => (await player.items.owner(glove.asset)) === player.address, 'the glove to arrive')
    await until(async () => Number((await coins.info()).circulating) < supplyBefore, 'the coins to be burned')

    expect(Number((await coins.info()).circulating)).toBe(supplyBefore - order.price)
  }, 30_000)

  test('buying what you cannot afford says the price and the balance', async () => {
    const { game, session } = await table()
    await expect(game.order(session, ORIGIN, 'cap')).rejects.toThrow(
      'Golden Button Cap costs 6000 coins and you have 0. Press the button a few more times.',
    )
  }, 20_000)

  test('the shop does not sell things it does not sell', async () => {
    const { game, session } = await table()
    await expect(game.order(session, ORIGIN, 'a-second-house')).rejects.toThrow('does not sell "a-second-house"')
  }, 20_000)
})

describe('mob loot', () => {
  test('a defeated mob drops a claim the player writes on their own chain', async () => {
    const { game, player, session } = await table()
    const coins = await player.token(game.catalogue().coin.asset)
    const bundle = await game.loot(session, ORIGIN, kill(game, session, 'slime-1'))
    expect(bundle.root).toMatch(/^[0-9A-F]{64}$/)
    await player.claims.add(bundle)
    expect(await coins.balance()).toBe(25)
  }, 20_000)

  test('one kill pays once, however many times its event is presented', async () => {
    const { game, session } = await table()
    const event = kill(game, session, 'slime-2')
    const [first, retry] = await Promise.allSettled([
      game.loot(session, ORIGIN, event),
      game.loot(session, ORIGIN, event),
    ])
    expect(first.status).toBe('fulfilled')
    expect(retry.status).toBe('rejected')
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
    const { game, player, session } = await table({ exchange: false })
    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)
    expect(catalogue.exchange.open).toBe(false)

    await player.faucet(1)
    await player.pay({ to: game.address, amount: 0.25 })
    await Bun.sleep(200)
    expect(await coins.balance()).toBe(0)

    // The loop that matters is untouched: pressing still pays (SPEC §8).
    press(game, session, 9)
    await player.claims.add(await game.bank(session, ORIGIN))
    expect(await coins.balance()).toBe(9)
  }, 30_000)
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
