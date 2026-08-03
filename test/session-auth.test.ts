/**
 * What a session-ownership signature covers, and what it provably does not.
 *
 * The room tests in `test/auth.test.ts` cover the authorization boundary. These
 * cover the bytes underneath it: that the digest a wallet signs is disjoint
 * from every digest a Kei *block* signature covers, and that the wallet-side
 * signer cannot be talked into signing anything it did not derive itself.
 *
 * The point of asserting it against the real hasher rather than the doc comment
 * is that the doc comment cannot fail when `@keicoin/core` changes its layout.
 */

import { describe, expect, test } from 'bun:test'
import {
  blake2b,
  bytesToHex,
  canonicalJson,
  hashBlock,
  keyPairFromSeed,
  keiBlockDomain,
  signHash,
  utf8,
  type StateBlockBody,
} from '@keicoin/core'

import { verifyOwnershipProof } from '../server/auth.js'
import {
  AUTH_DOMAIN,
  AUTH_VERSION,
  ownershipChallengeHash,
  ownershipChallengeMessage,
  parseOwnershipChallenge,
  parseOwnershipChallengeMessage,
  signatureIn,
  type OwnershipChallenge,
} from '../shared/session-auth.js'
import { ownershipSigner } from '../src/ownership.js'

const ALICE = await keyPairFromSeed('1'.repeat(64), 0)
const BOB = await keyPairFromSeed('2'.repeat(64), 0)

const CHALLENGE: OwnershipChallenge = {
  domain: AUTH_DOMAIN,
  version: AUTH_VERSION,
  address: ALICE.address,
  roomId: 'button-room-1',
  sessionId: 'session-a',
  playerId: 'A'.repeat(64),
  nonce: 'B'.repeat(64),
}

/** A real, hashable Kei block on Alice's chain — the thing that moves money. */
const SEND: StateBlockBody = {
  type: 'state',
  subtype: 'send',
  account: ALICE.address,
  previous: '0'.repeat(64),
  representative: ALICE.address,
  balance: '1000000',
  link: BOB.publicKey,
}

/** A block with no consensus layout, which `hashBlock` puts under its own preamble. */
const LOCAL: StateBlockBody = { ...SEND, memo: 'a memo has no state-block field' }

describe('domain separation', () => {
  test('the signed preimage is the ownership domain, and no block hash starts that way', () => {
    const preimage = utf8(`${AUTH_DOMAIN}\n${canonicalJson(CHALLENGE)}`)
    expect(ownershipChallengeHash(CHALLENGE)).toBe(bytesToHex(blake2b(preimage, 32)))

    // A consensus block opens with 32 raw bytes of blake2b("kei-block-v1").
    // An ASCII domain string cannot be those bytes, and the first byte is
    // enough to say so.
    const blockDomain = keiBlockDomain()
    expect(preimage.slice(0, blockDomain.length)).not.toEqual(blockDomain)
    expect(preimage[0]).toBe('k'.charCodeAt(0))
    expect(blockDomain[0]).not.toBe('k'.charCodeAt(0))
  })

  test('a signature over any Kei block hash does not authenticate a session', async () => {
    for (const body of [SEND, LOCAL]) {
      const blockHash = hashBlock(body)
      expect(blockHash).not.toBe(ownershipChallengeHash(CHALLENGE))

      // Alice really signs her own real block, with her own real key. It is
      // still not a proof of session ownership, because it covers other bytes.
      const signature = await signHash(ALICE.privateKey, blockHash)
      expect(await verifyOwnershipProof(CHALLENGE, { signature })).toBe(false)
    }
  })

  test('an ownership signature is not a signature over any block this wallet could publish', async () => {
    const signature = await signHash(ALICE.privateKey, ownershipChallengeHash(CHALLENGE))
    expect(await verifyOwnershipProof(CHALLENGE, { signature })).toBe(true)

    // The other direction of the same claim: what the room accepted cannot be
    // replayed at a node as the signature on a block.
    expect(signature).not.toBe(await signHash(ALICE.privateKey, hashBlock(SEND)))
    expect(signature).not.toBe(await signHash(ALICE.privateKey, hashBlock(LOCAL)))
  })

  test('the domain and the version are both inside the signed bytes', async () => {
    const drifted = [
      { ...CHALLENGE, domain: 'keicoin.org/button/session-ownership/v2' },
      { ...CHALLENGE, version: 2 },
    ] as unknown as OwnershipChallenge[]

    for (const variant of drifted) {
      expect(ownershipChallengeHash(variant)).not.toBe(ownershipChallengeHash(CHALLENGE))
      const signature = await signHash(ALICE.privateKey, ownershipChallengeHash(variant))
      expect(await verifyOwnershipProof(CHALLENGE, { signature })).toBe(false)
    }
  })

  test('no field can be smuggled through the boundary of the one beside it', () => {
    // The classic concatenation bug: `a|bc` and `ab|c` hashing the same. JSON
    // quotes and escapes every value, so they cannot.
    const split = { ...CHALLENGE, roomId: 'room', sessionId: 'a-session' }
    const shifted = { ...CHALLENGE, roomId: 'rooma', sessionId: '-session' }
    expect(ownershipChallengeHash(split)).not.toBe(ownershipChallengeHash(shifted))

    const injected = { ...CHALLENGE, roomId: `room","sessionId":"${CHALLENGE.sessionId}` }
    expect(ownershipChallengeHash(injected)).not.toBe(ownershipChallengeHash(CHALLENGE))
  })
})

describe('reading an untrusted challenge', () => {
  test('exactly the seven signed fields are accepted, and an eighth is refused', () => {
    expect(parseOwnershipChallenge({ ...CHALLENGE })).toEqual(CHALLENGE)
    expect(() => parseOwnershipChallenge({ ...CHALLENGE, expires: 1 })).toThrow('unknown "expires"')
  })

  test('every field is bounded', () => {
    const bad: Array<[unknown, string]> = [
      [{ ...CHALLENGE, domain: 'evil.example/ownership/v1' }, 'not keicoin.org'],
      [{ ...CHALLENGE, version: '1' }, 'not version 1'],
      [{ ...CHALLENGE, address: `${ALICE.address}x` }, 'Kei address is invalid'],
      [{ ...CHALLENGE, roomId: '' }, 'room id is invalid'],
      [{ ...CHALLENGE, roomId: 'r'.repeat(129) }, 'room id is invalid'],
      [{ ...CHALLENGE, sessionId: `a${String.fromCharCode(0)}b` }, 'session id is invalid'],
      [{ ...CHALLENGE, playerId: 'a'.repeat(64) }, 'player id is invalid'],
      [{ ...CHALLENGE, nonce: 'B'.repeat(63) }, 'nonce is invalid'],
      [null, 'not an object'],
      [[CHALLENGE], 'not an object'],
    ]
    for (const [value, message] of bad) expect(() => parseOwnershipChallenge(value)).toThrow(message)
  })

  test('a getter is not a value, so nothing can answer twice between check and use', () => {
    let answered = false
    const trap = {
      ...CHALLENGE,
      get nonce() {
        // Valid once, then something else. Refusing accessors outright is what
        // makes "checked and signed the same bytes" true rather than likely.
        const first = !answered
        answered = true
        return first ? CHALLENGE.nonce : 'C'.repeat(64)
      },
    }
    expect(() => parseOwnershipChallenge(trap)).toThrow('accessor where a value belongs')
  })

  test('a message whose digest does not match its challenge is refused, not corrected', () => {
    const honest = ownershipChallengeMessage(CHALLENGE)
    expect(parseOwnershipChallengeMessage(honest)).toEqual(honest)
    expect(parseOwnershipChallengeMessage({ ...honest, hash: honest.hash.toLowerCase() })).toEqual(honest)

    expect(() => parseOwnershipChallengeMessage({ ...honest, hash: 'F'.repeat(64) })).toThrow('not safe to sign')
    expect(() => parseOwnershipChallengeMessage({ challenge: CHALLENGE })).toThrow('not safe to sign')
  })

  test('a proof carries a signature and nothing else', () => {
    const signature = 'A'.repeat(128)
    expect(signatureIn({ signature })).toBe(signature)
    expect(signatureIn({ signature: signature.toLowerCase() })).toBe(signature)
    for (const bad of [null, undefined, {}, [signature], { signature, address: ALICE.address }, { signature: 'A'.repeat(127) }]) {
      expect(signatureIn(bad)).toBeUndefined()
    }
  })
})

describe('the wallet-side signer', () => {
  test('proves its own address against a real room challenge', async () => {
    const signer = await ownershipSigner(ALICE.seed)
    expect(signer.address).toBe(ALICE.address)

    const proof = await signer.prove(ownershipChallengeMessage(CHALLENGE))
    expect(Object.keys(proof)).toEqual(['signature'])
    expect(await verifyOwnershipProof(CHALLENGE, proof)).toBe(true)
  })

  test('will not sign a digest it did not derive itself', async () => {
    const signer = await ownershipSigner(ALICE.seed)

    // The attack this exists to stop: a hostile room sends a well-formed
    // challenge with the hash of a real send in the `hash` field, hoping the
    // wallet signs the bytes rather than the structure.
    const oracle = { challenge: CHALLENGE, hash: hashBlock(SEND) }
    await expect(signer.prove(oracle)).rejects.toThrow('not safe to sign')

    // And nothing was signed on the way to refusing: the block is unsigned.
    expect(await verifyOwnershipProof(CHALLENGE, { signature: hashBlock(SEND) })).toBe(false)
  })

  test('refuses a challenge addressed to another wallet', async () => {
    const signer = await ownershipSigner(BOB.seed)
    await expect(signer.prove(ownershipChallengeMessage(CHALLENGE))).rejects.toThrow('different wallet')
  })

  test('refuses a foreign domain, a foreign version, and a malformed message', async () => {
    const signer = await ownershipSigner(ALICE.seed)
    const foreign = { ...CHALLENGE, domain: 'evil.example/ownership/v1' }

    await expect(signer.prove({ challenge: foreign, hash: 'F'.repeat(64) })).rejects.toThrow('not keicoin.org')
    await expect(signer.prove({ challenge: { ...CHALLENGE, version: 2 }, hash: 'F'.repeat(64) })).rejects.toThrow(
      'not version 1',
    )
    await expect(signer.prove(null)).rejects.toThrow('not an object')
  })

  test('exposes an address and no way to reach the key', async () => {
    const signer = await ownershipSigner(ALICE.seed)
    expect(Object.keys(signer).sort()).toEqual(['address', 'prove'])
    expect(JSON.stringify(signer)).not.toContain(ALICE.seed)
    expect(JSON.stringify(signer)).not.toContain(ALICE.privateKey)
  })
})
