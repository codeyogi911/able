#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const root = process.cwd()
const ignoredDirectories = new Set(['.git', '.wrangler', 'node_modules', 'dist', 'coverage', 'playwright-report', 'test-results'])
const ignoredFiles = new Set(['package-lock.json', 'worker-configuration.d.ts', 'wrangler.production.generated.json'])
const forbiddenNames = [/\.sqlite(?:3)?$/i, /\.db$/i, /\.zip$/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /\.key$/i, /^\.npmrc$/, /^\.dev\.vars$/, /^\.env(?:\.|$)/]
// Deployment-specific identities do not belong in this public repository,
// even as an encoded denylist. Private release automation can inject one
// token per line without teaching the source tree those values.
const customerTokens = (process.env.ABLE_PRIVATE_DENYLIST ?? '')
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean)
const required = ['LICENSE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'docs/architecture.md', 'docs/deployment.md', 'docs/privacy-and-backups.md']
const textExtensions = new Set(['', '.css', '.html', '.js', '.json', '.jsonc', '.md', '.mjs', '.sql', '.ts', '.tsx', '.txt', '.yaml', '.yml'])

async function walk(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(filename))
    else if (entry.isFile()) files.push(filename)
  }
  return files
}

/**
 * The publication risk is what git would include: tracked files plus
 * untracked files not covered by .gitignore. Properly ignored local state —
 * .dev.vars, local databases — cannot reach the public repository and must
 * not fail the scan on a developer machine. Outside a git checkout, fall
 * back to scanning the whole tree.
 */
async function publishableFiles() {
  try {
    const { stdout } = await promisify(execFile)(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    )
    return stdout.split('\0').filter(Boolean).map((rel) => path.join(root, rel))
  } catch {
    return walk(root)
  }
}

function relative(filename) {
  return path.relative(root, filename).split(path.sep).join('/')
}

function personalEmails(text) {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []
  return matches.filter((email) => {
    const normalizedEmail = email.toLowerCase()
    if (normalizedEmail === 'noreply@github.com') return false
    const domain = normalizedEmail.split('@')[1]
    return !['example.com', 'example.net', 'example.org', 'example.test', 'users.noreply.github.com'].includes(domain)
  })
}

const failures = []
for (const requiredFile of required) {
  try {
    if (!(await stat(path.join(root, requiredFile))).isFile()) failures.push(`${requiredFile}: required file is missing`)
  } catch {
    failures.push(`${requiredFile}: required file is missing`)
  }
}

for (const filename of await publishableFiles()) {
  const rel = relative(filename)
  if (ignoredFiles.has(rel)) continue
  if (forbiddenNames.some((pattern) => pattern.test(path.basename(filename)))) {
    failures.push(`${rel}: local state or secret-bearing file type must not be published`)
    continue
  }
  if (!textExtensions.has(path.extname(filename).toLowerCase())) continue
  let data
  try {
    data = await readFile(filename)
  } catch {
    // Listed but no longer on disk (e.g. staged deletion) — nothing to scan.
    continue
  }
  if (data.includes(0)) continue
  const text = data.toString('utf8')
  const lowered = text.toLowerCase()
  for (const token of customerTokens) {
    if (lowered.includes(token.toLowerCase())) failures.push(`${rel}: contains a deployment-specific identity token`)
  }
  for (const email of personalEmails(text)) failures.push(`${rel}: contains non-example email ${email}`)
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(text) && /^wrangler(?:\.[^.]+)*\.jsonc$/.test(path.basename(filename))) {
    failures.push(`${rel}: contains a concrete resource identifier`)
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) failures.push(`${rel}: contains a private key`)
}

if (failures.length) {
  console.error(`Public-readiness scan failed:\n${[...new Set(failures)].map((failure) => `- ${failure}`).join('\n')}`)
  process.exit(1)
}

console.log('Public-readiness scan passed: generic identity, file hygiene, and required governance files are present.')
