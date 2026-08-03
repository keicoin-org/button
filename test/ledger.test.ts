/**
 * What the player is told about their own money.
 *
 * `test/economy.test.ts` proves the loop works against a real chain. This proves
 * the other half: that while the loop is running, no figure on the screen is a
 * lie. A press has to move the headline immediately, a coin has to be in exactly
 * one stage at a time, and nothing that is still owed may make a purchase look
 * possible — including when the server pays less than was counted, and including
 * when a claim fails.
 */

import { describe, expect, test } from 'bun:test'

import {
  banked,
  bankingFailed,
  bankingStarted,
  canAfford,
  claimExpected,
  claimFailed,
  clearingCovers,
  clearingNote,
  countedCoins,
  emptyLedger,
  pendingCoins,
  pressed,
  purchaseBlock,
  reconcileConfirmed,
  spendableCoins,
  type CoinLedger,
} from '../src/ledger.js'

/** A fresh ledger with `coins` worth of presses counted and nothing banked. */
function afterPresses(coins: number): CoinLedger {
  return pressed(emptyLedger(), coins)
}

describe('the headline', () => {
  test('a press moves it on the press, with nothing awaited', () => {
    let ledger = emptyLedger()
    expect(countedCoins(ledger)).toBe(0)

    ledger = pressed(ledger, 4)
    expect(countedCoins(ledger)).toBe(4)

    ledger = pressed(ledger, 4)
    expect(countedCoins(ledger)).toBe(8)
  })

  test('it is a tally, and the spendable figure under it has not moved', () => {
    const ledger = afterPresses(40)
    expect(countedCoins(ledger)).toBe(40)
    expect(spendableCoins(ledger)).toBe(0)
    expect(pendingCoins(ledger)).toBe(40)
  })

  test('it keeps moving while a batch is in flight', () => {
    let ledger = bankingStarted(afterPresses(20))
    expect(ledger.banking).toBe(20)
    expect(ledger.unbanked).toBe(0)

    ledger = pressed(ledger, 3)
    expect(countedCoins(ledger)).toBe(23)
    expect(ledger.unbanked).toBe(3)
  })
})

describe('reconciliation', () => {
  test('every stage change conserves the tally', () => {
    let ledger = afterPresses(20)
    const counted = countedCoins(ledger)

    ledger = bankingStarted(ledger)
    expect(countedCoins(ledger)).toBe(counted)

    ledger = banked(ledger, 20, 20)
    expect(ledger).toMatchObject({ unbanked: 0, banking: 0, settling: 20, confirmed: 0 })
    expect(countedCoins(ledger)).toBe(counted)

    ledger = reconcileConfirmed(ledger, 20)
    expect(ledger).toMatchObject({ unbanked: 0, banking: 0, settling: 0, confirmed: 20 })
    expect(countedCoins(ledger)).toBe(counted)
  })

  test('the chain confirming does not double-count what is still settling', () => {
    // The same event arrives twice — the wallet summary rising, and this
    // browser's own claim resolving. Only the rise moves coins, so the second
    // one changes nothing.
    let ledger = banked(bankingStarted(afterPresses(12)), 12, 12)
    ledger = reconcileConfirmed(ledger, 12)
    ledger = reconcileConfirmed(ledger, 12)

    expect(countedCoins(ledger)).toBe(12)
    expect(spendableCoins(ledger)).toBe(12)
    expect(pendingCoins(ledger)).toBe(0)
  })

  test('a batch settling while another is being pressed drains only its own', () => {
    let ledger = banked(bankingStarted(afterPresses(20)), 20, 20)
    ledger = pressed(ledger, 7)
    ledger = reconcileConfirmed(ledger, 20)

    expect(ledger).toMatchObject({ confirmed: 20, settling: 0, unbanked: 7 })
    expect(countedCoins(ledger)).toBe(27)
  })

  test('spending lowers the confirmed figure and settles nothing', () => {
    let ledger = reconcileConfirmed(banked(bankingStarted(afterPresses(200)), 200, 200), 200)
    ledger = pressed(ledger, 10)
    ledger = bankingStarted(ledger)
    ledger = banked(ledger, 10, 10)

    // 200 confirmed, 10 settling; the shop burns 150 of the confirmed coins.
    ledger = reconcileConfirmed(ledger, 50)
    expect(ledger).toMatchObject({ confirmed: 50, settling: 10 })
    expect(countedCoins(ledger)).toBe(60)
  })
})

describe('a capped payout', () => {
  test('the tally drops to what was actually signed for, once', () => {
    // server/game.ts caps a bank that arrived too fast to be a hand, and the
    // bundle carries the capped figure.
    let ledger = bankingStarted(afterPresses(1_000))
    ledger = banked(ledger, 1_000, 60)

    expect(ledger).toMatchObject({ banking: 0, settling: 60 })
    expect(countedCoins(ledger)).toBe(60)

    // And confirming it does not drop it a second time.
    ledger = reconcileConfirmed(ledger, 60)
    expect(countedCoins(ledger)).toBe(60)
    expect(spendableCoins(ledger)).toBe(60)
  })

  test('a cap does not touch presses made after the batch left', () => {
    let ledger = bankingStarted(afterPresses(500))
    ledger = pressed(ledger, 9)
    ledger = banked(ledger, 500, 25)

    expect(ledger).toMatchObject({ unbanked: 9, banking: 0, settling: 25 })
    expect(countedCoins(ledger)).toBe(34)
  })
})

describe('when something fails', () => {
  test('a bank that never got a proof puts the presses back', () => {
    let ledger = bankingStarted(afterPresses(20))
    ledger = pressed(ledger, 5)
    ledger = bankingFailed(ledger, 20)

    expect(ledger).toMatchObject({ unbanked: 25, banking: 0, settling: 0 })
    // The player pressed the button; a failed fetch does not un-press it.
    expect(countedCoins(ledger)).toBe(25)
  })

  test('a restored batch banks again without duplicating itself', () => {
    let ledger = bankingFailed(bankingStarted(afterPresses(20)), 20)
    ledger = bankingStarted(ledger)
    ledger = banked(ledger, 20, 20)
    ledger = reconcileConfirmed(ledger, 20)

    expect(spendableCoins(ledger)).toBe(20)
    expect(countedCoins(ledger)).toBe(20)
  })

  test('a claim that did not land leaves the tally instead of returning to unbanked', () => {
    let ledger = banked(bankingStarted(afterPresses(20)), 20, 20)
    ledger = claimFailed(ledger, 20)

    // The game already paid for those presses. Putting them back would bank
    // them twice on the retry.
    expect(ledger).toMatchObject({ unbanked: 0, banking: 0, settling: 0 })
    expect(countedCoins(ledger)).toBe(0)
  })

  test('a failed claim takes only its own coins out of settling', () => {
    let ledger = claimExpected(banked(bankingStarted(afterPresses(20)), 20, 20), 25)
    expect(pendingCoins(ledger)).toBe(45)

    ledger = claimFailed(ledger, 25)
    expect(pendingCoins(ledger)).toBe(20)
  })

  test('a claim that failed and landed anyway is confirmed once, not counted twice', () => {
    // `claims.add` keeps the bundle it was handed, so a failed claim is retried
    // by the next one. The tally drops meanwhile and the rise puts it back.
    let ledger = claimFailed(banked(bankingStarted(afterPresses(20)), 20, 20), 20)
    expect(countedCoins(ledger)).toBe(0)

    ledger = reconcileConfirmed(ledger, 20)
    expect(ledger).toMatchObject({ confirmed: 20, settling: 0 })
    expect(countedCoins(ledger)).toBe(20)
  })

  test('a retried claim landing beside a fresh batch settles both exactly once', () => {
    let ledger = claimFailed(banked(bankingStarted(afterPresses(20)), 20, 20), 20)
    ledger = banked(bankingStarted(pressed(ledger, 12)), 12, 12)
    expect(pendingCoins(ledger)).toBe(12)

    // The retry rides along with the new batch, so both land as one rise.
    ledger = reconcileConfirmed(ledger, 32)
    expect(ledger).toMatchObject({ confirmed: 32, settling: 0 })
    expect(countedCoins(ledger)).toBe(32)
  })

  test('draining more than is there stops at zero rather than going negative', () => {
    expect(claimFailed(emptyLedger(), 99)).toEqual(emptyLedger())
    expect(bankingFailed(emptyLedger(), 99)).toEqual(emptyLedger())
    expect(reconcileConfirmed(afterPresses(5), 0)).toMatchObject({ confirmed: 0, unbanked: 5 })
  })
})

describe('what the stages cannot be asked to do', () => {
  // `src/economy.ts` serialises the whole of a bank — ask, take the proof, write
  // the claim — behind a flag of its own. These are the two facts that flag
  // exists for, in the arithmetic, since the scheduler itself needs a browser.

  test('`banking` is already empty while that batch is still being claimed', () => {
    // The window: the proof is back, so the coins have left `banking`, and
    // `kei.claims.add` for them has not been called yet. Anything reading
    // `banking > 0` as "a bank is in flight" is blind for the whole of it.
    const proofBack = banked(bankingStarted(afterPresses(20)), 20, 20)
    expect(proofBack.banking).toBe(0)
    expect(proofBack.settling).toBe(20)
  })

  test('two overlapping batches share one settling figure, so a rollback cannot pick', () => {
    let ledger = banked(bankingStarted(afterPresses(20)), 20, 20)
    ledger = banked(bankingStarted(pressed(ledger, 12)), 12, 12)
    expect(ledger.settling).toBe(32)

    // Both claims went through the SDK's one map of held bundles and swept the
    // same proof; the second call is the one that was told the root was already
    // claimed, so it rolls back the amount it knows — its own 12. The coins that
    // did not land were the other call's 20. The figure is a scalar and there is
    // no version of `claimFailed` that could tell them apart.
    expect(claimFailed(ledger, 12).settling).toBe(20)
  })
})

describe('affordability', () => {
  test('pending coins never make a row affordable', () => {
    const pressedHard = afterPresses(400)
    expect(countedCoins(pressedHard)).toBe(400)
    expect(canAfford(pressedHard, 150)).toBe(false)

    const banking = bankingStarted(pressedHard)
    expect(canAfford(banking, 150)).toBe(false)

    const settling = banked(banking, 400, 400)
    expect(canAfford(settling, 150)).toBe(false)

    const confirmed = reconcileConfirmed(settling, 400)
    expect(canAfford(confirmed, 150)).toBe(true)
  })

  test('a row is affordable at exactly its price', () => {
    const ledger = reconcileConfirmed(emptyLedger(), 150)
    expect(canAfford(ledger, 150)).toBe(true)
    expect(canAfford(ledger, 151)).toBe(false)
  })

  test('the row says how short it is, and whether waiting would cover it', () => {
    const nearly = pressed(reconcileConfirmed(emptyLedger(), 120), 40)
    expect(clearingCovers(nearly, 150)).toBe(true)
    expect(clearingNote(nearly, 150)).toBe('30 short — clearing')

    const nowhere = pressed(reconcileConfirmed(emptyLedger(), 10), 5)
    expect(clearingCovers(nowhere, 150)).toBe(false)
    expect(clearingNote(nowhere, 150)).toBe('140 short')

    expect(clearingNote(reconcileConfirmed(emptyLedger(), 150), 150)).toBeNull()
    expect(clearingCovers(reconcileConfirmed(emptyLedger(), 150), 150)).toBe(false)
  })
})

describe('the gate in front of /game/order', () => {
  test('a purchase backed by confirmed coins is not blocked', () => {
    const ledger = reconcileConfirmed(emptyLedger(), 400)
    expect(purchaseBlock(ledger, 'Springy Glove', 25)).toBeNull()
  })

  test('a purchase backed by clearing coins is refused, and says which figure is which', () => {
    const ledger = banked(bankingStarted(afterPresses(400)), 400, 400)
    expect(purchaseBlock(ledger, 'Brass Knuckle', 150)).toBe(
      'Brass Knuckle costs 150 coins and 0 of yours are confirmed. Another 400 is still clearing — spendable once the chain accepts it.',
    )
  })

  test('with nothing clearing it says to press the button instead of to wait', () => {
    expect(purchaseBlock(emptyLedger(), 'Brass Knuckle', 150)).toBe(
      'Brass Knuckle costs 150 coins and 0 of yours are confirmed. Press the button a few more times.',
    )
  })

  test('the refusal counts the confirmed part of a mixed ledger', () => {
    const ledger = pressed(reconcileConfirmed(emptyLedger(), 100), 80)
    expect(purchaseBlock(ledger, 'Brass Knuckle', 150)).toBe(
      'Brass Knuckle costs 150 coins and 100 of yours are confirmed. Another 80 is still clearing — spendable once the chain accepts it.',
    )
  })
})

describe('coins that did not come from a press', () => {
  test('a mob drop clears through the same stage as a banked press', () => {
    let ledger = claimExpected(afterPresses(10), 25)
    expect(countedCoins(ledger)).toBe(35)
    expect(canAfford(ledger, 25)).toBe(false)

    ledger = reconcileConfirmed(ledger, 25)
    expect(ledger).toMatchObject({ confirmed: 25, settling: 0, unbanked: 10 })
    expect(canAfford(ledger, 25)).toBe(true)
  })

  test('a top-up has to be registered before it is paid for, not after', () => {
    // 20 banked press coins are waiting on their claim when a 100-coin top-up
    // is minted. The mint is a rise like any other, so whatever is in `settling`
    // when it arrives is what it drains.
    const waiting = banked(bankingStarted(afterPresses(20)), 20, 20)

    const registeredAfter = claimExpected(reconcileConfirmed(waiting, 100), 100)
    // The press coins were drained by somebody else's mint, and the top-up now
    // sits in `settling` with nothing left to confirm it: 80 over the truth.
    expect(countedCoins(registeredAfter)).toBe(200)

    const registeredFirst = reconcileConfirmed(claimExpected(waiting, 100), 100)
    expect(registeredFirst).toMatchObject({ confirmed: 100, settling: 20 })
    expect(countedCoins(registeredFirst)).toBe(120)
  })
})
