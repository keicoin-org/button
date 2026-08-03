/**
 * Proof that the socket claiming a Kei address can sign as that address.
 *
 * This is deliberately a game-session proof, not a transaction and not a bearer
 * token. The private key stays in the wallet; the room sees only a one-use
 * challenge and its signature.
 *
 * What a signature covers, and the domain separation that keeps it from
 * covering anything else, is `shared/session-auth.ts` — one definition, used by
 * this side and by the wallet. What is left here is the half only a server may
 * do: invent the opaque tokens, and check somebody else's signature.
 */

import { bytesToHex, publicKeyFromAddress, verifyHash } from '@keicoin/core'

import {
  AUTH_DOMAIN,
  AUTH_VERSION,
  TOKEN_HEX_LENGTH,
  ownershipChallengeHash,
  parseOwnershipChallenge,
  signatureIn,
  type OwnershipChallenge,
} from '../shared/session-auth.js'

export {
  AUTH_CHALLENGE,
  AUTH_DOMAIN,
  AUTH_PROOF,
  AUTH_RESULT,
  AUTH_VERSION,
  ownershipChallengeHash,
  ownershipChallengeMessage,
  parseOwnershipChallenge,
  parseOwnershipChallengeMessage,
} from '../shared/session-auth.js'
export type {
  AuthenticationResult,
  OwnershipChallenge,
  OwnershipChallengeMessage,
  OwnershipProofMessage,
} from '../shared/session-auth.js'

export interface ChallengeTokens {
  playerId: string
  nonce: string
}

/** Trusted construction seam for deterministic tests; never a room option. */
export type ChallengeTokenFactory = () => ChallengeTokens

export interface ChallengeContext {
  address: string
  roomId: string
  sessionId: string
}

/**
 * Build a challenge, and check it the same way the wallet is about to.
 *
 * Going out through `parseOwnershipChallenge` is not ceremony: it is what makes
 * "the room could not have asked for something the wallet would refuse" true by
 * construction rather than by two validators agreeing today.
 */
export function createOwnershipChallenge(
  context: ChallengeContext,
  tokens: ChallengeTokens,
): OwnershipChallenge {
  return parseOwnershipChallenge({
    domain: AUTH_DOMAIN,
    version: AUTH_VERSION,
    address: context.address,
    roomId: context.roomId,
    sessionId: context.sessionId,
    playerId: upperHex(tokens.playerId, 'player id'),
    nonce: upperHex(tokens.nonce, 'challenge nonce'),
  })
}

/** Verify without ever including the proof or the challenge in an error. */
export async function verifyOwnershipProof(
  challenge: OwnershipChallenge,
  message: unknown,
): Promise<boolean> {
  const signature = signatureIn(message)
  if (signature === undefined) return false

  try {
    return await verifyHash(
      ownershipChallengeHash(challenge),
      signature,
      publicKeyFromAddress(challenge.address),
    )
  } catch {
    return false
  }
}

/** Two independent 256-bit values from the runtime CSPRNG. */
export const secureChallengeTokens: ChallengeTokenFactory = () => ({
  playerId: randomHex(),
  nonce: randomHex(),
})

function randomHex(): string {
  const bytes = new Uint8Array(TOKEN_HEX_LENGTH / 2)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

/**
 * The canonical form of a token the factory produced.
 *
 * A factory is trusted code, so this is a shape check rather than a defence:
 * the signed form is uppercase, and a factory returning lowercase should be
 * corrected here once instead of producing a challenge nobody can verify.
 */
function upperHex(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`The ${label} is invalid.`)
  return value.toUpperCase()
}
