/**
 * The one place this game touches the player's key, and it is temporary.
 *
 * `kei-transaction` PR #142 adds `kei.wallet.signOwnershipChallenge()` — a
 * narrow signer that answers an ownership challenge for the wallet's own address
 * and nothing else. It is not in a published SDK yet, so this file does the same
 * job in game code, which is a real cost: the SDK's structural guarantee is that
 * game code cannot sign for a player (SPEC §6.3), and deriving the key here is
 * reaching around it.
 *
 * It is written to disappear rather than to be lived with:
 *
 *   - `sign()` **prefers the SDK's signer whenever the installed SDK has one.**
 *     Upgrading `kei-transaction` past #142 is the entire migration; no call
 *     site changes and nothing here has to be remembered. `test/ownership.test.ts`
 *     asserts the delegation happens and that the local path is not taken.
 *   - The request and the returned proof are already #142's shapes, so deleting
 *     this file later removes an import and nothing else.
 *
 * What it does not do, even now: it will not sign a challenge naming an address
 * this wallet does not hold, and it will not sign a digest a server handed it.
 * `parseOwnershipChallenge` rebuilds the digest from the fields and refuses a
 * disagreement — otherwise a hostile server could name 32 bytes, get them
 * signed, and have those bytes be the hash of a send.
 */

import { keyPairFromSeed, type Kei } from 'kei-transaction'

import {
  signOwnershipChallenge,
  type OwnershipChallengeMessage,
  type OwnershipProof,
} from '../shared/ownership.js'

/** The signer #142 puts on `kei.wallet`, as an optional member of what is there now. */
type MaybeSdkSigner = {
  signOwnershipChallenge?: (message: OwnershipChallengeMessage) => Promise<OwnershipProof>
}

/**
 * Answer an ownership challenge for this wallet's address.
 *
 * `index` is the account within the seed. Button never passes one, because
 * `Kei.start()` never takes one either; it is here so the local derivation
 * matches the SDK's default rather than assuming it.
 */
export async function sign(kei: Kei, message: OwnershipChallengeMessage, index = 0): Promise<OwnershipProof> {
  const wallet = kei.wallet as unknown as MaybeSdkSigner
  if (typeof wallet.signOwnershipChallenge === 'function') {
    // The SDK has it. The seed is never read on this path.
    return wallet.signOwnershipChallenge(message)
  }

  // The interim path. `kei.seed` throws under `reveal: 'never'`, which is the
  // honest failure: a wallet that will not show its seed cannot be proven by a
  // game holding no signer, and #142 is what fixes that rather than this file.
  const keys = await keyPairFromSeed(kei.seed, index)
  if (keys.address !== kei.address) {
    throw new Error('This wallet derived a different address than it reports. Refusing to sign.')
  }
  return signOwnershipChallenge({ privateKey: keys.privateKey, address: keys.address }, message)
}
