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
import { purchaseMessage, purchaseTone } from '../shared/purchase.js'
import { issuanceCost, startGame } from '../server/game.js'
import { ORIGIN, bank, batchId, join, kill, open, press, table as freshTable, until } from './support.js'

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
    const bundle = await bank(game, session)
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

    const bundles = await Promise.all(sessions.map((session) => bank(game, session)))
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
    const [first, second] = await Promise.allSettled([bank(game, session), bank(game, session)])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')

    await player.claims.add((first as PromiseFulfilledResult<ClaimBundle>).value)
    expect(await coins.balance()).toBe(10)
  }, 20_000)

  test('banking before this server watched anything is a sentence, not a block', async () => {
    const { game, session } = await table()
    await expect(bank(game, session)).rejects.toThrow('has not seen any presses from you yet')
  }, 20_000)
})

/**
 * What happens when the answer to a bank is lost.
 *
 * A bank does two things that cannot be undone — it empties the press tally,
 * and it puts an entitlement in an issuer block that is on the chain forever —
 * and both are finished before the response is written. So a response lost
 * after that point leaves the player paid and unable to collect: the proof is
 * the only route to the coins, and it went with the response.
 *
 * The batch id is what makes that recoverable. These tests are written from the
 * client's seat, where "the answer was lost" and "the request never arrived"
 * look identical, because that is the situation the id exists for.
 */
describe('a bank names its batch', () => {
  test('a batch whose answer was lost is recovered by its id, not bought again', async () => {
    const { game, player, session } = await table()
    const coins = await player.token(game.catalogue().coin.asset)

    press(game, session, 20)
    const batch = batchId()
    // Signed, committed, and then the answer does not arrive. The client holds
    // nothing: no proof, and twenty presses it can no longer account for.
    const lost = await bank(game, session, batch)

    // So it asks again, naming the batch rather than opening a new one.
    const recovered = await bank(game, session, batch)

    expect(recovered.root).toBe(lost.root)
    expect(recovered.amount).toBe(lost.amount)

    // One entitlement for those twenty presses, and the player can reach it.
    await player.claims.add(recovered)
    expect(await coins.balance()).toBe(20)

    // And the retry took nothing: there is no tally left for a further batch to
    // sell, which is what a second root for these presses would have been.
    await expect(bank(game, session, batchId())).rejects.toThrow('has not seen any presses from you yet')
  }, 20_000)

  test('two requests carrying one batch id are one payout', async () => {
    const { game, player, session } = await table()
    const coins = await player.token(game.catalogue().coin.asset)

    press(game, session, 20)
    const batch = batchId()
    // A retry that overtakes the request it is retrying. Both are the same
    // batch, so the second joins the first rather than starting one.
    const [first, second] = await Promise.all([bank(game, session, batch), bank(game, session, batch)])

    expect(second.root).toBe(first.root)
    await player.claims.add(first)
    expect(await coins.balance()).toBe(20)
  }, 20_000)

  test('a batch that failed is not remembered, so its id can honestly be used again', async () => {
    const { game, player, session } = await table()
    const coins = await player.token(game.catalogue().coin.asset)

    const batch = batchId()
    // Refused, because this server had watched nothing yet. Nothing was signed
    // under the id, so nothing is owed under it either.
    await expect(bank(game, session, batch)).rejects.toThrow('has not seen any presses from you yet')

    press(game, session, 7)
    await player.claims.add(await bank(game, session, batch))
    expect(await coins.balance()).toBe(7)
  }, 20_000)

  test('a batch is answered to the wallet that opened it and to no other', async () => {
    const { game, node, session } = await table()
    const { player: other } = await join(node)
    running.push(other)
    const theirs = await open(game, other)

    press(game, session, 5)
    const batch = batchId()
    await bank(game, session, batch)

    // Guessing somebody else's batch id is not a way to be handed their proof.
    press(game, theirs, 5)
    await expect(bank(game, theirs, batch)).rejects.toThrow('opened by a different wallet')
  }, 20_000)

  test('distinct ids are distinct batches, so real presses are still paid', async () => {
    const { game, player, session } = await table()
    const coins = await player.token(game.catalogue().coin.asset)

    press(game, session, 6)
    await player.claims.add(await bank(game, session))
    press(game, session, 4)
    await player.claims.add(await bank(game, session))
    expect(await coins.balance()).toBe(10)
  }, 20_000)

  test('a bank without a batch id is refused rather than made unretryable', async () => {
    const { game, session } = await table()
    press(game, session, 3)
    await expect(game.bank(session, ORIGIN, undefined)).rejects.toThrow('Send a batch id')
    await expect(game.bank(session, ORIGIN, 'not a batch id')).rejects.toThrow('A batch id is up to 64')
    // Refused before anything was taken: the presses are still the server's to pay.
    const bundle = await bank(game, session)
    expect(Number(bundle.amount)).toBe(3)
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
    await player.claims.add(await bank(game, session))
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
    await player.claims.add(await bank(game, session))
    const order = await game.order(session, ORIGIN, 'knuckle')
    await coins.transfer(order.to, order.price)
    await until(async () => (await player.items.owner(knuckle.asset)) === player.address, 'the knuckle to arrive')

    const before = await coins.balance()
    press(game, session, 10)
    await player.claims.add(await bank(game, session))
    // +4 a press, and the server worked that out by reading the player's holdings.
    expect((await coins.balance()) - before).toBe(50)
  }, 30_000)

  test('coins spent in the shop are burned, not banked', async () => {
    const { game, player, session } = await table()
    const catalogue = game.catalogue()
    const coins = await player.token(catalogue.coin.asset)
    const glove = catalogue.upgrades.find((upgrade) => upgrade.sku === 'glove')!

    press(game, session, 400)
    await player.claims.add(await bank(game, session))
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
    await player.claims.add(await bank(game, session))
    press(game, theirSession, cap.price)
    await second.claims.add(await bank(game, theirSession))

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
    await player.claims.add(await bank(game, session))
    press(game, theirSession, cap.price)
    await second.claims.add(await bank(game, theirSession))

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
    await player.claims.add(await bank(game, session))
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
    await player.claims.add(await bank(game, session))
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
    await player.claims.add(await bank(game, session))
    const before = await coins.balance()

    const order = await game.order(session, ORIGIN, 'glove')
    await coins.transfer(order.to, order.price + 5)
    await until(async () => (await player.items.owner(glove.asset)) === player.address, 'the glove to arrive')
    await until(async () => (await coins.balance()) === before - order.price, 'the difference to come back')
  }, 30_000)

  /**
   * The half of a purchase the player could not see.
   *
   * PR #13 made every arrival reach one of two endings — the item, or the coins
   * back. These say the player can tell which one happened, because before this
   * they could not: the optimistic "it will arrive in a moment" was the last
   * thing on the screen either way, and a refund nobody is told about is close
   * to indistinguishable from money that vanished.
   */
  describe('what the player is told', () => {
    test('a delivered purchase reads as delivered, by name', async () => {
      const { game, player, session } = await table()
      const catalogue = game.catalogue()
      const coins = await player.token(catalogue.coin.asset)
      const glove = catalogue.upgrades.find((upgrade) => upgrade.sku === 'glove')!

      press(game, session, 400)
      await player.claims.add(await bank(game, session))

      const order = await game.order(session, ORIGIN, 'glove')
      // Open before anything is paid, and honest about it.
      expect(game.purchases(session, ORIGIN).at(-1)).toMatchObject({ id: order.id, state: 'open' })

      await coins.transfer(order.to, order.price)
      await until(async () => (await player.items.owner(glove.asset)) === player.address, 'the glove to arrive')
      await until(
        async () => game.purchases(session, ORIGIN).at(-1)?.state === 'delivered',
        'the shop to say it delivered',
      )

      const receipt = game.purchases(session, ORIGIN).at(-1)!
      expect(receipt).toMatchObject({ id: order.id, state: 'delivered', item: 'Springy Glove', paid: 25, returned: 0 })
      // The name, never the asset id (kei-transaction#130).
      expect(receipt.item).not.toBe(glove.asset)
      expect(purchaseMessage(receipt)).toBe('The Springy Glove arrived.')
      expect(purchaseTone(receipt)).toBe('good')
    }, 30_000)

    test('a refunded purchase reads as refunded, with the amount and the reason', async () => {
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
      await player.claims.add(await bank(game, session))
      const before = await coins.balance()

      const order = await game.order(session, ORIGIN, 'glove')
      await coins.transfer(order.to, order.price)
      await until(async () => (await coins.balance()) === before, 'the coins to come back')
      await until(
        async () => game.purchases(session, ORIGIN).at(-1)?.state === 'returned',
        'the shop to say it refunded',
      )

      const receipt = game.purchases(session, ORIGIN).at(-1)!
      expect(receipt).toMatchObject({ id: order.id, state: 'returned', returned: 25, paid: 0 })
      expect(purchaseMessage(receipt)).toBe('Your 25 coins came back: the shop could not deliver the Springy Glove.')
      // Which is the whole point: this and a delivery are different sentences in
      // different colours, and were the same silence before.
      expect(purchaseTone(receipt)).toBe('warn')
    }, 30_000)

    test('change from an overpayment is accounted for rather than just appearing', async () => {
      const { game, player, session } = await table()
      const catalogue = game.catalogue()
      const coins = await player.token(catalogue.coin.asset)
      const glove = catalogue.upgrades.find((upgrade) => upgrade.sku === 'glove')!

      press(game, session, 400)
      await player.claims.add(await bank(game, session))

      const order = await game.order(session, ORIGIN, 'glove')
      await coins.transfer(order.to, order.price + 5)
      await until(async () => (await player.items.owner(glove.asset)) === player.address, 'the glove to arrive')
      await until(async () => (game.purchases(session, ORIGIN).at(-1)?.returned ?? 0) > 0, 'the change to be recorded')

      const receipt = game.purchases(session, ORIGIN).at(-1)!
      expect(receipt).toMatchObject({ state: 'delivered', paid: 25, returned: 5 })
      expect(purchaseMessage(receipt)).toBe('The Springy Glove arrived. 5 coins came back as change.')
    }, 30_000)

    test('coins the shop was not expecting are accounted for too', async () => {
      const { game, player, session } = await table()
      const catalogue = game.catalogue()
      const coins = await player.token(catalogue.coin.asset)

      press(game, session, 400)
      await player.claims.add(await bank(game, session))

      // A transfer against no order at all. It comes back, and saying so is the
      // difference between a refund and coins that left and returned in silence.
      await coins.transfer(game.address, 10)
      await until(
        async () => game.purchases(session, ORIGIN).some((receipt) => receipt.state === 'returned'),
        'the unmatched payment to be recorded',
      )

      const receipt = game.purchases(session, ORIGIN).at(-1)!
      expect(receipt).toMatchObject({ state: 'returned', returned: 10 })
      expect(purchaseMessage(receipt)).toBe('Your 10 coins came back: the shop had no open order for it.')
    }, 30_000)

    test('the answer outlives the order, so a reloaded page can still ask for it', async () => {
      const { game, player, session } = await table()
      const catalogue = game.catalogue()
      const coins = await player.token(catalogue.coin.asset)
      const glove = catalogue.upgrades.find((upgrade) => upgrade.sku === 'glove')!

      press(game, session, 400)
      await player.claims.add(await bank(game, session))
      const order = await game.order(session, ORIGIN, 'glove')
      await coins.transfer(order.to, order.price)
      await until(async () => (await player.items.owner(glove.asset)) === player.address, 'the glove to arrive')

      // The order record is deleted on delivery. A browser that was reloaded
      // mid-purchase has neither the order nor the message, and is asking on the
      // strength of its wallet alone — which is what this answers to.
      const reopened = await open(game, player)
      await until(
        async () => game.purchases(reopened, ORIGIN).at(-1)?.state === 'delivered',
        'the new session to be told how it ended',
      )
      expect(game.purchases(reopened, ORIGIN).at(-1)!.id).toBe(order.id)
    }, 30_000)

    test('a receipt is answered to the wallet that paid and to no other', async () => {
      const { game, player, node, session } = await table()
      const catalogue = game.catalogue()
      const coins = await player.token(catalogue.coin.asset)

      press(game, session, 400)
      await player.claims.add(await bank(game, session))
      const order = await game.order(session, ORIGIN, 'glove')
      await coins.transfer(order.to, order.price)
      await until(
        async () => game.purchases(session, ORIGIN).at(-1)?.state === 'delivered',
        'the shop to say it delivered',
      )

      // Somebody else's session is not a way to read what this wallet bought.
      const { player: other } = await join(node)
      running.push(other)
      expect(game.purchases(await open(game, other), ORIGIN)).toEqual([])
    }, 30_000)
  })

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
    await player.claims.add(await bank(game, session))
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
