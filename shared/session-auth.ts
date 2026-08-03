/**
 * The one definition of what a session-ownership signature covers.
 *
 * Shared by both halves for the same reason `shared/catalogue.ts` is, except
 * that here a drift between the two copies would not be a wrong price — it
 * would be a wallet signing bytes it did not mean. The room builds a challenge
 * through the parser below, the wallet re-derives the digest through the same
 * parser, and neither side has its own arithmetic to get wrong.
 *
 * ## Why the wallet must not sign the `hash` it is handed
 *
 * The challenge message carries a digest, and a client that simply signed it
 * would have handed the server a signing oracle: the server names 32 bytes and
 * the wallet signs them. Those bytes could be a Kei block hash, and the
 * signature would be a valid send. So the digest travels as a courtesy — a
 * checkable statement of what the server thinks it asked for — and the wallet
 * signs only what it derived itself from the structured, bounded, typed
 * challenge below.
 *
 * ## The separation that makes that safe
 *
 * `@keicoin/core` hashes blocks two ways, and this is neither:
 *
 * | what              | preimage begins with                        |
 * |-------------------|---------------------------------------------|
 * | consensus block   | `blake2b-256("kei-block-v1")`, 32 raw bytes |
 * | local-only block  | the ASCII `kei-block-local-v0` and a newline |
 * | session ownership | the ASCII `keicoin.org/button/session-ownership/v1` and a newline |
 *
 * Three prefixes that cannot be each other, so a signature made under one of
 * them is not a signature under another. `test/session-auth.test.ts` asserts it
 * against the real hasher rather than trusting this table.
 */

import { blake2b, bytesToHex, canonicalJson, isAddress, utf8 } from '@keicoin/core'

/** The room asks on this, the wallet answers on that, the room rules on the third. */
export const AUTH_CHALLENGE = 'auth:challenge'
export const AUTH_PROOF = 'auth:proof'
export const AUTH_RESULT = 'auth:result'

/**
 * Changing the payload or its meaning requires a new domain and version.
 *
 * The version is in the signed bytes as well as in the domain string, so an old
 * wallet and a new room cannot agree by accident: they disagree on the digest
 * and the signature simply does not verify.
 */
export const AUTH_DOMAIN = 'keicoin.org/button/session-ownership/v1' as const
export const AUTH_VERSION = 1 as const

/** Two 256-bit opaque values, in hex, so a challenge token is 64 characters. */
export const TOKEN_HEX_LENGTH = 64

const MAX_ROOM_ID = 128
const MAX_SESSION_ID = 128

/** Uppercase only. One canonical encoding means no side has to normalise. */
const TOKEN = /^[0-9A-F]{64}$/
const SIGNATURE = /^[0-9a-fA-F]{128}$/

/** Exactly these seven fields are signed, and nothing else ever is. */
export interface OwnershipChallenge {
  domain: typeof AUTH_DOMAIN
  version: typeof AUTH_VERSION
  address: string
  roomId: string
  sessionId: string
  playerId: string
  nonce: string
}

/** Sent privately to the joining socket. `hash` is checkable, not authoritative. */
export interface OwnershipChallengeMessage {
  challenge: OwnershipChallenge
  hash: string
}

/** The only value the room accepts back from a client. */
export interface OwnershipProofMessage {
  signature: string
}

export type AuthenticationResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * A fixed-domain Blake2b-256 digest, which is the 32-byte shape Kei signs.
 *
 * `canonicalJson` sorts keys and drops `undefined`, so wallet and room cannot
 * disagree because of insertion order, and JSON's own quoting is what stops one
 * field's value from being read as the start of the next.
 */
export function ownershipChallengeHash(challenge: OwnershipChallenge): string {
  return bytesToHex(blake2b(utf8(`${AUTH_DOMAIN}\n${canonicalJson(challenge)}`), 32))
}

export function ownershipChallengeMessage(challenge: OwnershipChallenge): OwnershipChallengeMessage {
  return { challenge, hash: ownershipChallengeHash(challenge) }
}

/**
 * The strict reading of an untrusted challenge, used by whoever received one.
 *
 * It rebuilds the object rather than blessing the one it was given, so the
 * digest is taken over exactly seven known fields — an eighth would otherwise
 * ride along into `canonicalJson` and change what got signed. Unknown keys are
 * refused outright rather than dropped, because a room that sent one is not
 * speaking this version and should be told so.
 */
export function parseOwnershipChallenge(value: unknown): OwnershipChallenge {
  const source = plainObject(value, 'challenge')
  const signed = ['domain', 'version', 'address', 'roomId', 'sessionId', 'playerId', 'nonce']
  for (const key of Object.keys(source)) {
    if (!signed.includes(key)) {
      throw new Error(`That challenge carries an unknown "${key}" field, so it is not ${AUTH_DOMAIN}.`)
    }
  }

  if (source.domain !== AUTH_DOMAIN) throw new Error(`That challenge is not ${AUTH_DOMAIN}.`)
  if (source.version !== AUTH_VERSION) throw new Error(`That challenge is not version ${AUTH_VERSION}.`)

  const address = source.address
  if (!isAddress(address)) throw new Error('The claimed Kei address is invalid.')

  return {
    domain: AUTH_DOMAIN,
    version: AUTH_VERSION,
    address,
    roomId: identifier(source.roomId, 'room id', MAX_ROOM_ID),
    sessionId: identifier(source.sessionId, 'session id', MAX_SESSION_ID),
    playerId: token(source.playerId, 'player id'),
    nonce: token(source.nonce, 'challenge nonce'),
  }
}

/**
 * A challenge and the digest that came with it, agreed.
 *
 * The digest is recomputed and compared rather than trusted. A mismatch means
 * the two sides are not hashing the same thing, and the only safe answer to
 * that is to refuse: signing the arriving digest would be signing the server's
 * bytes, and signing the recomputed one in silence would leave a room that
 * cannot verify it looking like a wallet that will not prove itself.
 */
export function parseOwnershipChallengeMessage(value: unknown): OwnershipChallengeMessage {
  const source = plainObject(value, 'challenge message')
  const challenge = parseOwnershipChallenge(source.challenge)
  const hash = ownershipChallengeHash(challenge)
  if (typeof source.hash !== 'string' || source.hash.toUpperCase() !== hash) {
    throw new Error('That challenge does not hash to the digest it arrived with, so it is not safe to sign.')
  }
  return { challenge, hash }
}

/**
 * The signature in a proof message, and only the signature.
 *
 * One own key, the right name, the right shape. A proof that also names an
 * address is refused rather than having the address ignored: it is a client
 * asking for something this protocol does not offer, and answering it at all
 * would invite the next one to assume it worked.
 */
export function signatureIn(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined
  const ownKeys = Object.keys(message)
  if (ownKeys.length !== 1 || ownKeys[0] !== 'signature') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(message, 'signature')
  if (!descriptor || !('value' in descriptor)) return undefined
  const signature: unknown = descriptor.value
  return typeof signature === 'string' && SIGNATURE.test(signature) ? signature.toUpperCase() : undefined
}

/** Own data properties only — a getter or an inherited field is not a message. */
function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`That ${label} is not an object.`)
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) {
      throw new Error(`That ${label} has an accessor where a value belongs.`)
    }
    out[key] = descriptor.value
  }
  return out
}

function identifier(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || hasControlCharacter(value)) {
    throw new Error(`The ${label} is invalid.`)
  }
  return value
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`The ${label} is invalid.`)
  return value
}

/**
 * Written by code point rather than as a character class, because a range of
 * literal control bytes in a regex is exactly the sort of thing that survives
 * one editor and not the next.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}
