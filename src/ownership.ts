/**
 * The wallet's side of the room challenge, and the only place Button touches a key.
 *
 * A Kei address is public, so a room cannot take one on a client's word
 * (`docs/m8-session-auth.md`). Proving it needs a signature, and a signature
 * needs the player's key — which lives in the browser and nowhere else.
 *
 * ## What this is allowed to sign, and how narrow that is
 *
 * One thing: a `keicoin.org/button/session-ownership/v1` challenge whose
 * address is this wallet's own, whose fields are all in bounds, and whose
 * digest **this file computed** from the parsed structure. It cannot be handed
 * 32 bytes and asked to sign them. That distinction is the whole security
 * property: a signer that signs a server-supplied hash is a signing oracle, and
 * the bytes a hostile server would choose are a Kei send.
 *
 * ## Why the key is here at all, stated plainly
 *
 * SPEC §6.3 keeps the private key inside the SDK, and the high-level `Kei`
 * object exposes no arbitrary-message signer — deliberately. So Button
 * provisions the player's seed itself (§6.7 documents `seed` as a start
 * option), hands the same seed to `Kei.start`, and keeps the derived key
 * closed over in this module. The wallet is unchanged: same seed, same store
 * key, same address, so a returning player is the same player.
 *
 * That is a real concession and it should not be quietly enjoyed. What it does
 * not do is move the trust boundary that matters here: the key was already in
 * this page's heap and this origin's storage, the server still never sees a
 * secret, and no press or bank is authorised by anything but a signature. What
 * it does cost is the SDK's structural guarantee that game code *cannot* sign —
 * which is why the end state is `wallet.signOwnershipChallenge()` in the SDK
 * and this module deleted. The gap is tracked in `docs/m8-session-auth.md`.
 */

import { keyPairFromSeed, normalizeSeed, signHash } from '@keicoin/core'
import { defaultSeedStore, randomSeed, seedStoreKey } from 'kei-transaction'

import {
  parseOwnershipChallengeMessage,
  type OwnershipProofMessage,
} from '../shared/session-auth.js'

/**
 * Everything the transport is given. It can prove the address and nothing else.
 *
 * Deliberately not the key pair, not the seed, and not a `signHash`: a caller
 * holding this can answer a room challenge and has no second use for it.
 */
export interface OwnershipSigner {
  readonly address: string
  /** Throws — with a sentence — rather than signing anything it cannot check. */
  prove(challengeMessage: unknown): Promise<OwnershipProofMessage>
}

/**
 * The seed this browser plays as, created on first visit and kept after that.
 *
 * The same store and the same key the SDK would have used on its own, so
 * provisioning it here changes who writes it and not which wallet it is.
 */
export function playerSeed(network: string): string {
  const store = defaultSeedStore()
  const key = seedStoreKey(network)
  const existing = store.read(key)
  if (existing) return existing

  const seed = randomSeed()
  store.write(key, seed)
  return seed
}

/**
 * Derive the signer for a seed.
 *
 * The key pair is local, closed over, and never returned. Deriving it through
 * the SDK's own `keyPairFromSeed` is what puts the seed and private key on the
 * scrub list, so neither can reach a thrown error or a log line through
 * anything that formats one (SPEC §6.6).
 */
export async function ownershipSigner(seed: string, index = 0): Promise<OwnershipSigner> {
  const keys = await keyPairFromSeed(normalizeSeed(seed, 'player seed'), index)

  return {
    address: keys.address,

    async prove(challengeMessage: unknown): Promise<OwnershipProofMessage> {
      // Parses, bounds-checks, and re-derives the digest from the structure.
      // The `hash` the room sent is compared against that, never signed.
      const { challenge, hash } = parseOwnershipChallengeMessage(challengeMessage)

      // A challenge for somebody else's address is not something this wallet
      // can prove, and signing it would not help: it verifies against the
      // address it names, which is not this one. Refusing says so out loud.
      if (challenge.address !== keys.address) {
        throw new Error('That challenge is addressed to a different wallet, so this one cannot answer it.')
      }

      return { signature: await signHash(keys.privateKey, hash) }
    },
  }
}
