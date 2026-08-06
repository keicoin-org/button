import { expect, test } from 'bun:test'
import type { ClaimBundle } from 'kei-transaction'

import { serialClaims } from '../src/claim-queue.js'

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** A bundle real enough for the queue to key on — every test below reads only `root`. */
function bundle(root: string): ClaimBundle {
  return { root, asset: 'A'.repeat(64), amount: '0', proof: [] }
}

test('a mob claim cannot enter the SDK sweep while a bank claim is still there', async () => {
  const first = deferred()
  const second = deferred()
  const started: string[] = []
  const claim = serialClaims(async (held) => {
    started.push(held.root)
    await (held.root === 'bank' ? first.promise : second.promise)
  })

  const bank = claim(bundle('bank'))
  const loot = claim(bundle('loot'))
  await Promise.resolve()
  expect(started).toEqual(['bank'])

  first.resolve()
  await bank
  await Promise.resolve()
  expect(started).toEqual(['bank', 'loot'])

  second.resolve()
  await loot
})

test('a refused claim does not wedge the next one', async () => {
  const started: string[] = []
  const claim = serialClaims(async (held) => {
    started.push(held.root)
    if (held.root === 'bad') throw new Error('root already claimed')
  })

  await expect(claim(bundle('bad'))).rejects.toThrow('root already claimed')
  await expect(claim(bundle('retry'))).resolves.toBeUndefined()
  expect(started).toEqual(['bad', 'retry'])
})

/**
 * The shape #26 introduces: `DropBatch` merges a bank and a loot landing in the
 * same window into one leaf, and hands the identical bundle to both callers.
 * Both still call `addClaim` with it, and that must not mean the SDK sees the
 * same root twice.
 */
test('two callers holding the same bundle submit it once and share the outcome', async () => {
  const started: string[] = []
  const claim = serialClaims(async (held) => {
    started.push(held.root)
  })

  const shared = bundle('merged-root')
  const [first, second] = await Promise.all([claim(shared), claim(shared)])
  expect(started).toEqual(['merged-root'])
  expect(first).toBeUndefined()
  expect(second).toBeUndefined()
})

test('a root is free to be submitted again once the first attempt on it has finished', async () => {
  const started: string[] = []
  const claim = serialClaims(async (held) => {
    started.push(held.root)
    if (started.filter((root) => root === held.root).length === 1) throw new Error('not yet')
  })

  const shared = bundle('retry-root')
  // A genuine retry — the same root, sent again after the first attempt is
  // done — is not the case above: it goes through the SDK again rather than
  // being answered from a stale in-flight entry.
  await expect(claim(shared)).rejects.toThrow('not yet')
  await expect(claim(shared)).resolves.toBeUndefined()
  expect(started).toEqual(['retry-root', 'retry-root'])
})
