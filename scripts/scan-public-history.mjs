#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import process from 'node:process'

const execFile = promisify(execFileCallback)
const allowedEmailDomains = new Set(['example.com', 'example.net', 'example.org', 'example.test', 'users.noreply.github.com'])
const allowedEmailAddresses = new Set(['noreply@github.com'])

async function git(args, options = {}) {
  try {
    const { stdout } = await execFile('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options })
    return stdout.trim()
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 1) return ''
    throw error
  }
}

function privateTokens() {
  return (process.env.PUBLIC_HISTORY_DENYLIST ?? '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function personalEmails(history) {
  return [...new Set(history.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
    .filter((email) => {
      const normalizedEmail = email.toLowerCase()
      if (allowedEmailAddresses.has(normalizedEmail)) return false
      const domain = normalizedEmail.split('@')[1]
      return !allowedEmailDomains.has(domain)
    })
}

const failures = []
const tokens = privateTokens()

if (!tokens.length) {
  failures.push('PUBLIC_HISTORY_DENYLIST is required; provide private tenant and predecessor identifiers one per line outside source control')
}

const commits = (await git(['rev-list', '--all'])).split(/\r?\n/).filter(Boolean)
if (!commits.length) failures.push('repository has no reachable commits')

const emails = personalEmails(await git(['log', '--all', '--format=%ae%n%ce']))
for (const email of emails) failures.push(`history contains a non-noreply, non-example author or committer email: ${email}`)

for (const token of tokens) {
  for (const commit of commits) {
    const files = await git(['grep', '-I', '-l', '-i', '-F', '-e', token, commit])
    for (const filename of files.split(/\r?\n/).filter(Boolean)) {
      failures.push(`history contains a private identifier in ${filename} at ${commit.slice(0, 12)}`)
    }
  }
}

if (failures.length) {
  console.error(`Public-history scan failed:\n${[...new Set(failures)].map((failure) => `- ${failure}`).join('\n')}`)
  process.exit(1)
}

console.log(`Public-history scan passed: ${commits.length} reachable commit(s), no supplied private identifiers, and no personal commit emails.`)
