import { expect, test } from 'bun:test'

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

test('a mob claim cannot enter the SDK sweep while a bank claim is still there', async () => {
  const first = deferred()
  const second = deferred()
  const started: string[] = []
  const claim = serialClaims(async (bundle: string) => {
    started.push(bundle)
    await (bundle === 'bank' ? first.promise : second.promise)
  })

  const bank = claim('bank')
  const loot = claim('loot')
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
  const claim = serialClaims(async (bundle: string) => {
    started.push(bundle)
    if (bundle === 'bad') throw new Error('root already claimed')
  })

  await expect(claim('bad')).rejects.toThrow('root already claimed')
  await expect(claim('retry')).resolves.toBeUndefined()
  expect(started).toEqual(['bad', 'retry'])
})
