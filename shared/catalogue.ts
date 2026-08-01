/**
 * What the game sells, and what pressing is worth.
 *
 * Shared by both halves on purpose. The server is authoritative about payouts
 * because it is the only side that can mint, but the client has to predict the
 * same numbers to draw them, and two copies of this arithmetic would drift
 * within an afternoon.
 *
 * Nothing here is a balance. Balances live on the chain; this is a price list.
 */

export interface Upgrade {
  /** Stable id in this file. The on-chain asset id is derived from the name. */
  sku: string
  name: string
  description: string
  /** In COIN. */
  price: number
  /** How many can exist across every player. */
  supply: number
  /** Extra coins per press, per copy owned. */
  perPress?: number
  /** Presses per second, per copy owned, with nobody touching anything. */
  pressesPerSecond?: number
  /** Multiplies the whole payout. Counted once however many are owned. */
  multiplier?: number
}

export const COIN = {
  name: 'Coins',
  symbol: 'COIN',
  decimals: 0,
  maxSupply: 1_000_000_000,
} as const

/** The exchange desk: 1 Kei buys this many coins. Issuer config, never on-chain. */
export const COINS_PER_KEI = 1_000

/** Below this, a payment is a rounding error and gets ignored. */
export const MINIMUM_TOP_UP = 0.001

export const UPGRADES: readonly Upgrade[] = [
  {
    sku: 'glove',
    name: 'Springy Glove',
    description: 'A glove with a spring in it. +1 coin per press.',
    price: 25,
    supply: 100_000,
    perPress: 1,
  },
  {
    sku: 'knuckle',
    name: 'Brass Knuckle',
    description: 'Heavier. Louder. +4 coins per press.',
    price: 150,
    supply: 100_000,
    perPress: 4,
  },
  {
    sku: 'auto-mk1',
    name: 'Auto-Presser Mk I',
    description: 'A small arm that presses once a second, forever.',
    price: 400,
    supply: 100_000,
    pressesPerSecond: 1,
  },
  {
    sku: 'auto-mk2',
    name: 'Auto-Presser Mk II',
    description: 'Three arms. Slightly alarming. +3 presses a second.',
    price: 1_500,
    supply: 100_000,
    pressesPerSecond: 3,
  },
  {
    sku: 'cap',
    name: 'Golden Button Cap',
    description: 'Purely decorative, and it doubles everything.',
    price: 6_000,
    // M4's unique native item: the NPC can sell exactly one on the network.
    supply: 1,
    multiplier: 2,
  },
]

export function upgradeBySku(sku: string): Upgrade | undefined {
  return UPGRADES.find((upgrade) => upgrade.sku === sku)
}

export interface Payout {
  /** Coins earned by one press. */
  perPress: number
  /** Presses a second that happen without anybody pressing. */
  pressesPerSecond: number
}

/** `owned` is a count per sku — a player can hold several of the same upgrade. */
export function payoutFor(owned: Readonly<Record<string, number>>): Payout {
  let perPress = 1
  let pressesPerSecond = 0
  let multiplier = 1

  for (const upgrade of UPGRADES) {
    const count = owned[upgrade.sku] ?? 0
    if (count <= 0) continue
    perPress += (upgrade.perPress ?? 0) * count
    pressesPerSecond += (upgrade.pressesPerSecond ?? 0) * count
    if (upgrade.multiplier) multiplier *= upgrade.multiplier
  }

  return { perPress: perPress * multiplier, pressesPerSecond }
}

/** What the server tells the client about this game. Item ids are derived on-chain. */
export interface CataloguePayload {
  issuer: string
  network: string
  coin: { asset: string; symbol: string; decimals: number }
  /** Off when the game is running with payments disabled (SPEC §8). */
  exchange: { open: boolean; coinsPerKei: number; minimum: number }
  upgrades: Array<Upgrade & { asset: string }>
}
