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
import { KEI_DECIMALS, Kei, MockNode, randomSeed, type Block, type ClaimBundle, type KeiNode } from 'kei-transaction'

import { COIN, COINS_PER_KEI, UPGRADES, payoutFor, upgradeBySku } from '../shared/catalogue.js'
import { issuanceCost, startGame } from '../server/game.js'
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

/**
 * The same chain, with one block refused: the mint that would deliver `item`.
 *
 * That is what supply running out between an order and its payment looks like
 * from the shop's side, and what a node that timed out looks like too — the two
 * ways a paid-for delivery fails (SPEC §5.6.6). Nothing in the game is stubbed:
 * the failure is injected at the node interface the SDK is written against, so
 * what is under test is the shop's real recovery path.
 */
function nodeRefusingToMint(node: MockNode, item: () => string | null): KeiNode {
  return Object.assign(Object.create(node) as MockNode, {
    async process(block: Block): Promise<{ hash: string }> {
      if (block.type === 'asset' && block.op.kind === 'mint' && block.op.asset === item()) {
        throw new Error('over-supply: no units of this asset are left to mint')
      }
      return node.process(block)
    },
  })
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

  test('the second buyer of the supply-one cap is refused, and not charged for it', async () => {
    const { game, player, node, session } = await table()
    const catalogue = game.catalogue()
    const cap = catalogue.upgrades.find((upgrade) => upgrade.sku === 'cap')!

    const second = await Kei.start({ node, seed: randomSeed() })
    running.push(second)
    const theirSession = await open(game, second)
    const mine = await player.token(catalogue.coin.asset)
    const theirs = await second.token(catalogue.coin.asset)

    // Both players can afford it. Only one of them can own it.
    press(game, session, cap.price)
    await player.claims.add(await game.bank(session, ORIGIN))
    press(game, theirSession, cap.price)
    await second.claims.add(await game.bank(theirSession, ORIGIN))

    const order = await game.order(session, ORIGIN, 'cap')
    await mine.transfer(order.to, order.price)
    await until(async () => (await second.items.owner(cap.asset)) === player.address, 'the cap to arrive')

    const before = await theirs.balance()
    expect(before).toBe(cap.price)
    // The refusal has to land before any coins move: a transfer is signed by the
    // player, settled by the chain, and final, so a shop that takes the money
    // first has nothing left to offer but an apology.
    await expect(game.order(theirSession, ORIGIN, 'cap')).rejects.toThrow('The Golden Button Cap is sold out.')
    expect(await theirs.balance()).toBe(before)
  }, 30_000)

  test('two players cannot both be told to pay for the one copy', async () => {
    const { game, player, node, session } = await table()
    const catalogue = game.catalogue()
    const cap = catalogue.upgrades.find((upgrade) => upgrade.sku === 'cap')!

    const second = await Kei.start({ node, seed: randomSeed() })
    running.push(second)
    const theirSession = await open(game, second)
    press(game, session, cap.price)
    await player.claims.add(await game.bank(session, ORIGIN))
    press(game, theirSession, cap.price)
    await second.claims.add(await game.bank(theirSession, ORIGIN))

    // Neither has paid, so the chain still says one is unsold. Reading the supply
    // and then taking the order as two steps is what let both of these through.
    const taken = await Promise.allSettled([
      game.order(session, ORIGIN, 'cap'),
      game.order(theirSession, ORIGIN, 'cap'),
    ])
    expect(taken.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  }, 30_000)

  test('a delivery the chain refuses returns the coins instead of keeping them', async () => {
    const node = await MockNode.create()
    let blocked: string | null = null
    const game = await startGame({
      seed: randomSeed(),
      node: nodeRefusingToMint(node, () => blocked),
      network: 'mock',
      flushMs: 20,
      pressRateCap: 100_000,
    })
    const player = await Kei.start({ node, seed: randomSeed() })
    running.push(game, player)

    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)
    const glove = catalogue.upgrades.find((upgrade) => upgrade.sku === 'glove')!
    blocked = glove.asset

    const session = await open(game, player)
    press(game, session, 400)
    await player.claims.add(await game.bank(session, ORIGIN))
    const before = await coins.balance()

    const order = await game.order(session, ORIGIN, 'glove')
    await coins.transfer(order.to, order.price)
    await until(async () => (await coins.balance()) === before, 'the coins to come back')
    expect(await player.items.owner(glove.asset)).toBe(null)
  }, 30_000)

  test('a payment short of the price comes back, and the order stays open', async () => {
    const { game, player, session } = await table()
    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)
    const knuckle = catalogue.upgrades.find((upgrade) => upgrade.sku === 'knuckle')!

    press(game, session, 400)
    await player.claims.add(await game.bank(session, ORIGIN))
    const before = await coins.balance()

    // What a player who re-clicked a dearer row mid-transfer sends: the amount for
    // the row they left, against the order for the row they are on.
    const order = await game.order(session, ORIGIN, 'knuckle')
    await coins.transfer(order.to, 25)
    await until(async () => (await coins.balance()) === before, 'the short payment to come back')
    expect(await player.items.owner(knuckle.asset)).toBe(null)

    // The short payment did not consume the order, so paying properly still works.
    await coins.transfer(order.to, order.price)
    await until(async () => (await player.items.owner(knuckle.asset)) === player.address, 'the knuckle to arrive')
  }, 30_000)

  test('paying over the price delivers the item and returns the difference', async () => {
    const { game, player, session } = await table()
    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)
    const glove = catalogue.upgrades.find((upgrade) => upgrade.sku === 'glove')!

    press(game, session, 400)
    await player.claims.add(await game.bank(session, ORIGIN))
    const before = await coins.balance()

    const order = await game.order(session, ORIGIN, 'glove')
    await coins.transfer(order.to, order.price + 5)
    await until(async () => (await player.items.owner(glove.asset)) === player.address, 'the glove to arrive')
    await until(async () => (await coins.balance()) === before - order.price, 'the difference to come back')
  }, 30_000)

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

/**
 * What it costs this game to exist.
 *
 * Issuing is the one thing in Kei that is not free (SPEC §5.6.5), and the rule
 * is *the nth asset an account issues burns n Kei* — not the flat 1,000 the
 * grant here used to be sized against, which is the rule §5.6.5 replaced. So
 * the first test measures the burn against the chain rather than restating a
 * number, and the second says the grant is that measurement and not a literal
 * that can drift away from it.
 */
describe('funding the issuer', () => {
  test('issuing what this game issues burns 1+2+…+6 Kei, measured on the chain', async () => {
    const node = await MockNode.create()
    const issuer = await Kei.server({ seed: randomSeed(), node, network: 'mock' })
    running.push({ close: () => issuer.close() })

    // Funded well past any of it, so what is measured is the burn and not a
    // refusal part-way through.
    await issuer.faucet(1_000)
    const before = await issuer.balance()

    await issuer.token.issue({ ...COIN, transfer: 'open', swap: 'one-way', rate: COINS_PER_KEI })
    for (const upgrade of UPGRADES) {
      await issuer.items.create({
        name: upgrade.name,
        description: upgrade.description,
        supply: upgrade.supply,
        transfer: 'open',
      })
    }

    // Six assets: 1 + 2 + 3 + 4 + 5 + 6. Against the flat 1,000 this used to be
    // budgeted at, the difference is 21 Kei versus 6,000.
    expect(before - (await issuer.balance())).toBe(21)
    expect(issuanceCost(0, UPGRADES.length + 1)).toBe(21)

    // The price is per account and does not reset, so the *next* six cost more.
    expect(issuanceCost(UPGRADES.length + 1, UPGRADES.length + 1)).toBe(57)
  }, 30_000)

  test('the grant covers the issuances and leaves nothing spare', async () => {
    const { game, node } = await table()

    // `startGame` faucets what it is about to burn and then burns it, so an
    // issuer that has finished starting holds nothing. A grant sized against the
    // flat rule would have left 6,079 Kei sitting here — harmless in itself, but
    // it is the figure a reader copies, and it makes starting up depend on a
    // rate-limited faucet handing over two orders of magnitude more than needed.
    const account = await node.accountInfo(game.address)
    expect(Number(BigInt(account!.balance) / 10n ** BigInt(KEI_DECIMALS))).toBe(0)

    // And it did start: six assets on the chain, priced by the rule above.
    expect(account!.issuedCount).toBe(UPGRADES.length + 1)
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
