import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const deskRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function buildBrowserAsset(entry, outfile) {
  const result = await build({
    entryPoints: [resolve(deskRoot, entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
    sourcemap: false,
    outfile: resolve(deskRoot, outfile),
    write: false,
  })

  for (const output of result.outputFiles) {
    await writeFile(output.path, output.text.replace(/[\t ]+$/gm, ''), 'utf8')
  }
}
