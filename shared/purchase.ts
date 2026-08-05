/**
 * How a purchase ended, and the sentence the player reads for it.
 *
 * Buying is the one thing in this game the player cannot watch happen. A press
 * is answered by the counter moving, and a bank is answered by a proof arriving
 * — but a purchase is a transfer this browser signs and then an issuer block it
 * has no part in, so the only thing that can tell the player how it went is the
 * shop, and before this there was no channel for it to say. The optimistic "it
 * will arrive in a moment" was the last thing shown whether the item arrived,
 * the coins came back, or the mint failed. A refund the player cannot see is
 * close to indistinguishable from money that vanished.
 *
 * So a settled purchase is a value, and the words for it are here rather than in
 * the canvas — pure, and therefore testable without a browser or a chain, which
 * is the same reason `src/ledger.ts` is shaped the way it is.
 */

/**
 * The three things that can be true of an order.
 *
 * There is no `failed`. The shop's guarantee is that coins that arrive reach one
 * of two endings — the item, or the coins back — so a failure to deliver *is* a
 * return, and it is described as one.
 */
export type PurchaseState = 'open' | 'delivered' | 'returned'

export interface PurchaseReceipt {
  /** The order this is about, as `/game/order` named it. */
  id: string
  state: PurchaseState
  /** Which upgrade, when the shop could tell. A payment against no order cannot. */
  sku?: string
  /**
   * The item's name, as it is on the chain.
   *
   * Never an asset id: a player is not shown a hex string where a name exists
   * (kei-transaction#130), and this is the field that keeps that true of the
   * one sentence they read about their money.
   */
  item?: string
  /** Whole coins the shop kept, which is the price when something was delivered. */
  paid: number
  /** Whole coins that went back. Non-zero on a return, and on change from an overpayment. */
  returned: number
  /** Why they went back, in the shop's own words. */
  reason?: string
  at: number
}

/**
 * What to tell the player, in one sentence.
 *
 * Every branch names a figure or an item, because the point of the sentence is
 * to be *distinguishable*: "arrived" and "your coins came back" have to be
 * different things on the screen, and both have to be different from "still
 * waiting".
 */
export function purchaseMessage(receipt: PurchaseReceipt): string {
  const item = receipt.item ?? 'your order'
  const coins = (amount: number): string => `${amount} ${amount === 1 ? 'coin' : 'coins'}`

  if (receipt.state === 'delivered') {
    const arrived = `The ${item} arrived.`
    // Change from an overpayment. Worth saying, because coins moving back looks
    // identical to coins going missing if nothing accounts for them.
    return receipt.returned > 0 ? `${arrived} ${coins(receipt.returned)} came back as change.` : arrived
  }

  if (receipt.state === 'returned') {
    const back = `Your ${coins(receipt.returned)} came back`
    return receipt.reason ? `${back}: ${receipt.reason}.` : `${back}.`
  }

  // Open, and honest about what open means: the coins are on the chain and the
  // shop has not answered yet. Nothing here promises that it will.
  return `Waiting for the shop to settle the ${item}. Your coins are on the chain either way.`
}

/** How the sentence should read on screen. Green for the ending the player wanted. */
export function purchaseTone(receipt: PurchaseReceipt): 'good' | 'warn' | 'note' {
  if (receipt.state === 'delivered') return 'good'
  return receipt.state === 'returned' ? 'warn' : 'note'
}
