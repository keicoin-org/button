/**
 * One lane for every call into the SDK's claim sweep.
 *
 * `claims.add()` stores a bundle and then claims everything in one shared map.
 * Two callers can otherwise read the same held bundle before either submits it;
 * one wins and the other reports that the root was already claimed. Banking is
 * not the only caller — mob drops use the same wallet — so the lock belongs at
 * the claim call rather than around one feature.
 */
export function serialClaims<T>(write: (bundle: T) => Promise<unknown>): (bundle: T) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()

  return (bundle: T): Promise<void> => {
    const run = tail.then(async () => {
      await write(bundle)
    })
    // A failed claim is still returned to its caller, but must not wedge every
    // claim queued after it. The tail observes and absorbs only for sequencing.
    tail = run.catch(() => undefined)
    return run
  }
}
