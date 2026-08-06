#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const wrangler = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'
const config = path.join(root, 'wrangler.test.jsonc')
const persistence = mkdtempSync(path.join(tmpdir(), 'able-visual-'))
const seed = path.join(root, 'test', 'visual', 'seed.sql')
const port = Number.parseInt(process.env.ABLE_VISUAL_PORT ?? '8791', 10)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ABLE_VISUAL_PORT must be an unprivileged TCP port')

function run(arguments_, { inherit = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(wrangler, arguments_, {
      cwd: root,
      env: process.env,
      stdio: inherit ? 'inherit' : 'ignore',
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

const developmentEmail = process.env.ABLE_DEV_EMAIL ?? 'owner@example.com'
const optionalBindings = [
  'SHOPIFY_SHOP_DOMAIN',
  'SHOPIFY_ADMIN_TOKEN',
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
].flatMap((name) => process.env[name] ? ['--var', `${name}:${process.env[name]}`] : [])
const server = spawn(wrangler, [
  'dev',
  '--ip', '127.0.0.1',
  '--port', String(port),
  '--persist-to', persistence,
  '--var', `ABLE_DEV_EMAIL:${developmentEmail}`,
  '--var', 'ABLE_VOICE_DEMO_ENABLED:1',
  ...optionalBindings,
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
  rmSync(persistence, { recursive: true, force: true })
  if (code && code !== 0) process.exitCode = code
  else if (signal && !['SIGINT', 'SIGTERM'].includes(signal)) process.exitCode = 1
})
