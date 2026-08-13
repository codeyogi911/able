#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const wrangler = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'
const config = path.join(root, 'wrangler.jsonc')
const seed = path.join(root, 'scripts', 'local-parity-seed.sql')
const persistence = path.join(root, '.wrangler', 'local-parity')
const port = 8787

mkdirSync(persistence, { recursive: true })

function run(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(wrangler, arguments_, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`wrangler ${arguments_.join(' ')} exited with ${code ?? signal}`))
    })
  })
}

await run(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistence, '--config', config])
await run(['d1', 'execute', 'DB', '--local', '--persist-to', persistence, '--file', seed, '--config', config])

console.log('Local production-like data is ready. Open http://127.0.0.1:8787/')
console.log('Workers AI is remote; D1, R2, queues, Durable Objects, email, and customer data remain local.')

const server = spawn(wrangler, [
  'dev',
  '--ip', '127.0.0.1',
  '--port', String(port),
  '--persist-to', persistence,
  '--var', 'ABLE_DEV_EMAIL:owner@example.test',
  '--var', 'ABLE_VOICE_DEMO_ENABLED:1',
  '--config', config,
], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
})

function stop(signal) {
  if (!server.killed) server.kill(signal)
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
server.once('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
server.once('exit', (code, signal) => {
  if (code && code !== 0) process.exitCode = code
  else if (signal && !['SIGINT', 'SIGTERM'].includes(signal)) process.exitCode = 1
})
