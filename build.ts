/**
 * Builds the deployable copy: `dist/examples/button/`.
 *
 * The directory shape matches the URL shape, because Cloudflare's asset serving
 * maps one to the other and a mismatch is a 404 that looks like a bug in the
 * game. `bun run dev` does not use any of this — it serves from source.
 */

import { mkdir, readdir, rm, copyFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const root = Bun.fileURLToPath(new URL('.', import.meta.url))
const out = join(root, 'dist', 'examples', 'button')

await mkdir(out, { recursive: true })
for (const entry of await readdir(out)) {
  await rm(join(out, entry), { recursive: true, force: true }).catch(() => undefined)
}

const bundle = await Bun.build({
  entrypoints: [join(root, 'src/main.ts')],
  outdir: join(out, 'build'),
  target: 'browser',
  minify: true,
})
if (!bundle.success) {
  for (const log of bundle.logs) console.error(log)
  process.exit(1)
}

await mkdir(dirname(join(out, 'index.html')), { recursive: true })
await copyFile(join(root, 'index.html'), join(out, 'index.html'))
<<<<<<< Updated upstream
// The page asks for ./favicon.ico, which at /examples/button/ is this one and
// not the site's — same coin, served by whichever Worker owns the path.
await copyFile(join(root, 'public/favicon.ico'), join(out, 'favicon.ico'))
=======
for (const asset of ['favicon.ico', 'kei-coin-64.png']) {
  await copyFile(join(root, 'public', asset), join(out, asset))
}
>>>>>>> Stashed changes

const size = (await stat(join(out, 'build', 'main.js'))).size
console.log(`\n  dist/examples/button — ${(size / 1024 / 1024).toFixed(2)} MB\n`)
