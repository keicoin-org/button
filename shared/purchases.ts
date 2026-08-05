/**
 * How a purchase ended, and the sentence a player reads about it.
 *
 * Shared for the same reason `catalogue.ts` is: the server decides which ending
 * happened and the client has to say so, and two copies of the state names would
 * disagree the first time one of them gained a case.
 *
 * The reason a type like this exists at all is that a Kei purchase is two
 * signatures with a gap between them (SPEC §6.3). The player signs a transfer;
 * the issuer signs the delivery in response; and a transfer carries no memo, so
 * the player's only evidence of what became of their coins is what the shop
 * tells them afterwards. Before this the shop told them "it will arrive in a
 * moment" and then nothing at all — the same sentence whether the item landed,
 * the coins came back, or neither.
 */

export interface PurchaseRecord {
  /** The id `/game/order` returned, or absent for coins that matched no order. */
  id?: string
  sku?: string
  /**
   * The upgrade's on-chain name.
   *
   * A name, never an asset id: a hex string is not something a player can be
   * shown and expected to act on (kei-transaction#130).
   */
  item?: string
  /**
   * `open` — ordered, and no payment for it has settled yet.
   * `arrived` — the item was minted to this wallet.
   * `returned` — the coins went back, and `reason` says why.
   * `stuck` — neither happened. The one state that needs somebody to act.
   */
  state: 'open' | 'arrived' | 'returned' | 'stuck'
  /** Coins returned, for `returned` and `stuck`. */
  coins?: number
  /** Why, in the shop's own words. */
  reason?: string
  at: number
}

/** True once this purchase has an ending, rather than being still in progress. */
export function isSettled(entry: PurchaseRecord): boolean {
  return entry.state !== 'open'
}

/**
 * One sentence for the player.
 *
 * SPEC §6.1: it has to say what happened and, where there is one, what to do
 * about it. "Something went wrong" is not an ending.
 */
export function describePurchase(entry: PurchaseRecord): string {
  const what = entry.item ?? 'that'
  switch (entry.state) {
    case 'arrived':
      return `Your ${what} arrived. It is an item in your wallet now, and it works in any game that reads this chain.`
    case 'returned':
      return `${coinsIn(entry)} came back — ${entry.reason ?? 'the shop could not deliver it'}. You are not out of pocket.`
    case 'stuck':
      return `${coinsIn(entry)} for ${what} could neither be delivered nor returned. The shop has recorded it; nothing you can press will fix it.`
    case 'open':
      return `Your ${what} is not here yet. The shop has the order and is waiting for the payment to settle on the chain.`
  }
}

function coinsIn(entry: PurchaseRecord): string {
  const coins = entry.coins
  if (coins === undefined) return 'Your coins'
  return `${Math.floor(coins)} ${coins === 1 ? 'coin' : 'coins'}`
}
