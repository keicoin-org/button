/**
 * What a wallet is being asked to sign, and what that signature can and cannot
 * be turned into.
 *
 * This is the file to read if you want to know whether the challenge scheme is
 * a boundary or a shape check. Everything below runs against the real hasher and
 * real keys — none of it asserts against a comment or a table of prefixes — and
 * every case is one an untrusted client could actually send.
 */

import { describe, expect, test } from 'bun:test'
import {
  ZERO_HASH,
  addressFromPublicKey,
  hashBlock,
  keyPairFromSeed,
  publicKeyFromAddress,
  randomSeed,
  signHash,
  verifyHash,
  type StateBlockBody,
} from '@keicoin/core'

import {
  OWNERSHIP_DOMAIN,
  OwnershipError,
  ownershipChallengeHash,
  parseOwnershipChallenge,
  randomChallengeNonce,
  signOwnershipChallenge,
  verifyOwnershipProof,
  type NonceStore,
  type OwnershipChallenge,
} from '../shared/ownership.js'
import { sign } from '../src/ownership.js'
import type { Kei } from 'kei-transaction'

const DOMAIN = 'keicoin.org/button/session/v1'

async function wallet(): Promise<{ privateKey: string; address: string; publicKey: string }> {
  const keys = await keyPairFromSeed(randomSeed(), 0)
  return { privateKey: keys.privateKey, address: keys.address, publicKey: keys.publicKey }
}

function challengeFor(address: string, extra: Partial<OwnershipChallenge> = {}): OwnershipChallenge {
  return {
    domain: DOMAIN,
    address,
    nonce: randomChallengeNonce(),
    context: { room: 'kei_room', origin: 'http://localhost:7777' },
    ...extra,
  }
}

/** One-use, and nothing more: exactly the store shape the server passes in. */
function store(...nonces: string[]): NonceStore {
  const live = new Set(nonces)
  return { use: (nonce) => live.delete(nonce) }
}

describe('what the digest is', () => {
  test('a challenge and a block cannot hash to each other', async () => {
    const keys = await wallet()
    const challenge = challengeFor(keys.address)

    // A real send, hashed by the real hasher, signed with the real key.
    const send: StateBlockBody = {
      type: 'state',
      subtype: 'send',
      account: keys.address,
      previous: ZERO_HASH,
      representative: keys.address,
      balance: '0',
      link: publicKeyFromAddress(keys.address),
    }
    const sendHash = hashBlock(send)
    const sendSignature = await signHash(keys.privateKey, sendHash)

    const digest = ownershipChallengeHash(challenge)
    expect(digest).not.toBe(sendHash)

    // The signature on the send does not authenticate a session...
    expect(
      await verifyOwnershipProof(
        { address: keys.address, signature: sendSignature, challenge },
        { ...challenge, nonces: store(challenge.nonce) },
      ),
    ).toBe(false)

    // ...and the signature on the session does not authenticate the send.
    const proof = await signOwnershipChallenge(keys, challenge)
    expect(await verifyHash(sendHash, proof.signature, keys.publicKey)).toBe(false)
    expect(proof.signature).not.toBe(sendSignature)
  })

  test('the fixed domain leads the preimage, and a caller cannot move it', async () => {
    const keys = await wallet()
    expect(OWNERSHIP_DOMAIN.startsWith('kei-ownership-challenge-v1')).toBe(true)

    // Whatever a caller puts in `domain`, it is a signed field rather than the
    // leading bytes — so no `domain` string steers the preimage anywhere.
    const sneaky = ownershipChallengeHash(challengeFor(keys.address, { domain: 'kei-block-v1' }))
    const honest = ownershipChallengeHash(challengeFor(keys.address, { domain: 'kei-block-v1' }))
    expect(sneaky).not.toBe(honest) // different nonces
    expect(sneaky).toMatch(/^[0-9A-F]{64}$/)
  })

  test('an absent context and an empty one are the same challenge', () => {
    const address = 'kei_1butt0n'
    const nonce = randomChallengeNonce()
    expect(ownershipChallengeHash({ domain: DOMAIN, address, nonce })).toBe(
      ownershipChallengeHash({ domain: DOMAIN, address, nonce, context: {} }),
    )
  })

  test('context values cannot slide between keys', () => {
    const address = 'kei_1butt0n'
    const nonce = randomChallengeNonce()
    const base = { domain: DOMAIN, address, nonce }
    expect(ownershipChallengeHash({ ...base, context: { room: 'a', origin: 'bc' } })).not.toBe(
      ownershipChallengeHash({ ...base, context: { room: 'ab', origin: 'c' } }),
    )
  })
})

describe('the wallet is not a signing oracle', () => {
  test('a challenge naming a digest of its own choosing is refused, not signed', async () => {
    const keys = await wallet()
    const challenge = challengeFor(keys.address)

    // The attack in one line: a hostile server names the bytes it wants signed,
    // and those bytes are the hash of a send.
    const send: StateBlockBody = {
      type: 'state',
      subtype: 'send',
      account: keys.address,
      previous: ZERO_HASH,
      representative: keys.address,
      balance: '0',
      link: publicKeyFromAddress(keys.address),
    }

    await expect(signOwnershipChallenge(keys, { ...challenge, hash: hashBlock(send) })).rejects.toThrow(
      'not the digest of its own fields',
    )
  })

  test('a matching hash is accepted, because that is the honest case', async () => {
    const keys = await wallet()
    const challenge = challengeFor(keys.address)
    const proof = await signOwnershipChallenge(keys, { ...challenge, hash: ownershipChallengeHash(challenge) })
    expect(proof.address).toBe(keys.address)
  })

  test('a wallet will not sign for an address it does not hold', async () => {
    const [mine, theirs] = [await wallet(), await wallet()]
    await expect(signOwnershipChallenge(mine, challengeFor(theirs.address))).rejects.toThrow(
      'A wallet signs only for itself',
    )
  })
})

describe('what a proof does not open', () => {
  test('a proof for one address does not authenticate another', async () => {
    const [victim, attacker] = [await wallet(), await wallet()]
    const challenge = challengeFor(attacker.address)
    const proof = await signOwnershipChallenge(attacker, challenge)

    // The attacker holds a valid proof and relabels it. The address travels
    // inside the signed challenge, so relabelling changes the digest.
    expect(
      await verifyOwnershipProof(
        { ...proof, address: victim.address },
        { ...challenge, address: victim.address, nonces: store(challenge.nonce) },
      ),
    ).toBe(false)
  })

  test('a proof for one domain does not verify under another', async () => {
    const keys = await wallet()
    const challenge = challengeFor(keys.address, { domain: 'example.com/other-game/v1' })
    const proof = await signOwnershipChallenge(keys, challenge)
    expect(
      await verifyOwnershipProof(proof, { ...challenge, domain: DOMAIN, nonces: store(challenge.nonce) }),
    ).toBe(false)
  })

  test('a proof for one room or origin does not verify for another', async () => {
    const keys = await wallet()
    const challenge = challengeFor(keys.address)
    const proof = await signOwnershipChallenge(keys, challenge)

    for (const context of [
      { room: 'kei_somewhere_else', origin: 'http://localhost:7777' },
      { room: 'kei_room', origin: 'https://evil.example' },
    ]) {
      expect(await verifyOwnershipProof(proof, { ...challenge, context, nonces: store(challenge.nonce) })).toBe(
        false,
      )
    }
  })

  test('a nonce is spent once, and a forged signature does not spend it', async () => {
    const [keys, attacker] = [await wallet(), await wallet()]
    const challenge = challengeFor(keys.address)
    const proof = await signOwnershipChallenge(keys, challenge)
    const nonces = store(challenge.nonce)

    // A signature by the wrong key, over the right challenge. It must not burn
    // the nonce the honest client is still holding.
    const forged = { ...proof, signature: await signHash(attacker.privateKey, ownershipChallengeHash(challenge)) }
    expect(await verifyOwnershipProof(forged, { ...challenge, nonces })).toBe(false)

    expect(await verifyOwnershipProof(proof, { ...challenge, nonces })).toBe(true)
    expect(await verifyOwnershipProof(proof, { ...challenge, nonces })).toBe(false)
  })

  test('two verifications of one proof in flight together admit exactly one', async () => {
    const keys = await wallet()
    const challenge = challengeFor(keys.address)
    const proof = await signOwnershipChallenge(keys, challenge)
    const nonces = store(challenge.nonce)

    // `use` is one synchronous claim rather than a check and then a mark, which
    // is the only reason both of these do not pass.
    const results = await Promise.all([
      verifyOwnershipProof(proof, { ...challenge, nonces }),
      verifyOwnershipProof(proof, { ...challenge, nonces }),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

/**
 * `src/ownership.ts` exists only until the SDK ships `signOwnershipChallenge`
 * (kei-transaction #142). These two assert that the handover is automatic —
 * that upgrading the dependency is the whole migration, and that until then the
 * seed is read in exactly one place and only because there is no alternative.
 */
describe('handing the signer back to the SDK', () => {
  test('an SDK that has the signer is used, and the seed is never read', async () => {
    const keys = await wallet()
    const challenge = challengeFor(keys.address)
    const expected = await signOwnershipChallenge(keys, challenge)

    let asked = 0
    const sdk = {
      address: keys.address,
      get seed(): string {
        throw new Error('The seed must not be read when the SDK can sign.')
      },
      wallet: {
        async signOwnershipChallenge(message: unknown) {
          asked += 1
          expect(message).toEqual(challenge)
          return expected
        },
      },
    }

    expect(await sign(sdk as unknown as Kei, challenge)).toBe(expected)
    expect(asked).toBe(1)
  })

  test('an SDK without it falls back to a signature this game derives', async () => {
    const seed = randomSeed()
    const keys = await keyPairFromSeed(seed, 0)
    const challenge = challengeFor(keys.address)

    const sdk = { address: keys.address, seed, wallet: {} }
    const proof = await sign(sdk as unknown as Kei, challenge)

    expect(proof.address).toBe(keys.address)
    expect(await verifyHash(ownershipChallengeHash(challenge), proof.signature, keys.publicKey)).toBe(true)
  })
})

describe('what a proof may be made of', () => {
  test('an unknown field is refused rather than ignored', () => {
    expect(() => parseOwnershipChallenge({ ...challengeFor('kei_1abc'), role: 'admin' })).toThrow(
      'unknown field "role"',
    )
  })

  test('a getter cannot answer once for the check and again for the use', () => {
    const challenge = challengeFor('kei_1abc')
    let reads = 0
    const hostile = Object.defineProperty({ ...challenge }, 'nonce', {
      get() {
        reads += 1
        return reads === 1 ? challenge.nonce : 'something-else'
      },
      enumerable: true,
    })
    expect(() => parseOwnershipChallenge(hostile)).toThrow(OwnershipError)
  })

  test('control characters and oversized fields are refused', () => {
    expect(() => parseOwnershipChallenge(challengeFor('kei_1abc', { domain: 'a b' }))).toThrow(
      'control character',
    )
    expect(() => parseOwnershipChallenge(challengeFor('kei_1abc', { domain: 'x'.repeat(200) }))).toThrow(
      'longer than 128',
    )
  })

  test('anything that is not a proof is false rather than a throw', async () => {
    const keys = await wallet()
    const challenge = challengeFor(keys.address)
    for (const junk of [null, 'proof', 42, [], {}, { address: keys.address }, { challenge }]) {
      expect(await verifyOwnershipProof(junk, { ...challenge, nonces: store(challenge.nonce) })).toBe(false)
    }
  })

  test('a signature over a challenge whose address is not the claimed one is refused', async () => {
    const [keys, other] = [await wallet(), await wallet()]
    const challenge = challengeFor(keys.address)
    const proof = await signOwnershipChallenge(keys, challenge)
    expect(
      await verifyOwnershipProof(
        { ...proof, address: addressFromPublicKey(other.publicKey) },
        { ...challenge, nonces: store(challenge.nonce) },
      ),
    ).toBe(false)
  })
})
