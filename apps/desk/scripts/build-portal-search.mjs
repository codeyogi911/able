import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const result = await build({
  entryPoints: [resolve(repositoryRoot, 'src/portal/search-client.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  outfile: resolve(repositoryRoot, 'public/portal-search.js'),
  write: false,
})

for (const output of result.outputFiles) {
  await writeFile(output.path, output.text.replace(/[\t ]+$/gm, ''), 'utf8')
}
