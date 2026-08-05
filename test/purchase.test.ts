/**
 * The sentence a player reads about their money.
 *
 * No chain and no browser here, for the same reason `test/ledger.test.ts` has
 * neither: what is being checked is whether two different outcomes read as two
 * different outcomes. A refund the player cannot tell from a delivery is the
 * bug this file exists to keep fixed, and it is a bug about words.
 */

import { describe, expect, test } from 'bun:test'

import { purchaseMessage, purchaseTone, type PurchaseReceipt } from '../shared/purchase.js'

const receipt = (over: Partial<PurchaseReceipt>): PurchaseReceipt => ({
  id: 'order-1',
  state: 'open',
  sku: 'glove',
  item: 'Springy Glove',
  paid: 0,
  returned: 0,
  at: 0,
  ...over,
})

describe('what a settled purchase says', () => {
  test('a delivery names the item', () => {
    const delivered = receipt({ state: 'delivered', paid: 25 })
    expect(purchaseMessage(delivered)).toBe('The Springy Glove arrived.')
    expect(purchaseTone(delivered)).toBe('good')
  })

  test('a delivery with change accounts for the change', () => {
    expect(purchaseMessage(receipt({ state: 'delivered', paid: 25, returned: 5 }))).toBe(
      'The Springy Glove arrived. 5 coins came back as change.',
    )
  })

  test('a refund names the amount and the reason', () => {
    const returned = receipt({
      state: 'returned',
      returned: 25,
      reason: 'the shop could not deliver the Springy Glove',
    })
    expect(purchaseMessage(returned)).toBe('Your 25 coins came back: the shop could not deliver the Springy Glove.')
    expect(purchaseTone(returned)).toBe('warn')
  })

  test('a delivery and a refund are not the same sentence in the same colour', () => {
    const delivered = receipt({ state: 'delivered', paid: 25 })
    const returned = receipt({ state: 'returned', returned: 25, reason: 'the shop had no open order for it' })
    expect(purchaseMessage(delivered)).not.toBe(purchaseMessage(returned))
    expect(purchaseTone(delivered)).not.toBe(purchaseTone(returned))
  })

  test('pending says what pending means, and promises nothing', () => {
    const open = receipt({})
    expect(purchaseMessage(open)).toBe(
      'Waiting for the shop to settle the Springy Glove. Your coins are on the chain either way.',
    )
    expect(purchaseTone(open)).toBe('note')
    // No "it will arrive": the shop owes one of two endings and this does not
    // pick one on its behalf.
    expect(purchaseMessage(open)).not.toMatch(/will arrive/)
  })

  test('one coin is one coin', () => {
    expect(purchaseMessage(receipt({ state: 'returned', returned: 1, reason: 'it was a rounding error' }))).toBe(
      'Your 1 coin came back: it was a rounding error.',
    )
  })

  test('a payment the shop could not tie to an order still reads as something', () => {
    const stray = receipt({ state: 'returned', item: undefined, sku: undefined, returned: 10 })
    expect(purchaseMessage(stray)).toBe('Your 10 coins came back.')
  })
})
