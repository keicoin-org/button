import type { ClaimBundle } from 'kei-transaction'

/**
 * One lane for every call into the SDK's claim sweep, and one submission per
 * root.
 *
 * `claims.add()` stores a bundle and then claims everything in one shared map.
 * Two callers can otherwise read the same held bundle before either submits it;
 * one wins and the other reports that the root was already claimed. Banking is
 * not the only caller — mob drops use the same wallet, and since #26 a bank and
 * a loot that land in the same issuer block are handed the identical merged
 * bundle, each reading its own share of it — so the lock belongs at the claim
 * call rather than around one feature.
 *
 * A root already queued or already finished is not sent through the SDK a
 * second time: the second caller rides the first attempt and learns the same
 * outcome, rather than a duplicate submission the ledger would refuse and a
 * failure neither caller could have done anything about.
 */
export function serialClaims(write: (bundle: ClaimBundle) => Promise<unknown>): (bundle: ClaimBundle) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  const inFlight = new Map<string, Promise<void>>()

  return (bundle: ClaimBundle): Promise<void> => {
    const already = inFlight.get(bundle.root)
    if (already) return already

    const run = tail.then(async () => {
      await write(bundle)
    })
    // A failed claim is still returned to its caller, but must not wedge every
    // claim queued after it. The tail observes and absorbs only for sequencing.
    tail = run.catch(() => undefined)
    inFlight.set(bundle.root, run)
    // Once this root is settled, one way or the other, a bundle carrying it
    // again — a fresh drop cannot reuse a root, but a retried one can arrive
    // here again — is free to be submitted rather than answered from memory.
    // `run`'s own rejection is still `run`'s to report; this reads it only to
    // know when to clean up, the same way `tail`'s `.catch` above does.
    run.then(
      () => inFlight.delete(bundle.root),
      () => inFlight.delete(bundle.root),
    )
    return run
  }
}
