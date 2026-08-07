import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parse as parseJsonc } from 'jsonc-parser'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(repositoryRoot, 'wrangler.jsonc')
const outputPath = resolve(repositoryRoot, 'wrangler.production.generated.json')

function required(env, name, pattern) {
  const value = env[name]?.trim()
  if (!value || !pattern.test(value)) throw new Error(`${name} is missing or invalid`)
  return value
}

export function parseWranglerSource(text) {
  const errors = []
  const source = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error('wrangler.jsonc is not valid JSONC')
  }
  return source
}

export function createProductionConfig(source, env) {
  const databaseId = required(env, 'ABLE_D1_DATABASE_ID', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  const databaseName = required(env, 'ABLE_D1_DATABASE_NAME', /^[a-z0-9][a-z0-9_-]{1,62}$/)
  const bucketName = required(env, 'ABLE_R2_BUCKET_NAME', /^[a-z0-9][a-z0-9_-]{1,62}$/)
  const queueName = required(env, 'ABLE_MEDIA_QUEUE_NAME', /^[a-z0-9][a-z0-9_-]{1,62}$/)
  const config = structuredClone(source)

  // A deployment may run on a Worker whose name predates this one, and the
  // Worker name is not customer-visible when custom domains front it. Renaming
  // a Worker in place is not possible, so allow the name to be supplied like
  // every other deployment identifier rather than moving domains, Access
  // policy and email routing to a differently named Worker. Optional: the
  // committed name is the default.
  const workerName = env.ABLE_WORKER_NAME?.trim()
  if (workerName) {
    // A Worker name becomes a DNS label, so it may not start or end with a
    // hyphen, and is limited to 63 characters.
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName)) throw new Error('ABLE_WORKER_NAME is invalid')
    config.name = workerName
  }

  const database = config.d1_databases?.find((binding) => binding.binding === 'DB')
  const bucket = config.r2_buckets?.find((binding) => binding.binding === 'ATTACHMENTS')
  const producer = config.queues?.producers?.find((binding) => binding.binding === 'MEDIA_QUEUE')
  const consumer = config.queues?.consumers?.[0]
  if (!database || !bucket || !producer || !consumer) {
    throw new Error('Wrangler production resource bindings are incomplete')
  }

  database.database_id = databaseId
  database.database_name = databaseName
  bucket.bucket_name = bucketName
  producer.queue = queueName
  consumer.queue = queueName
  return config
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const source = parseWranglerSource(await readFile(sourcePath, 'utf8'))
  const production = createProductionConfig(source, process.env)
  await writeFile(outputPath, `${JSON.stringify(production, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  console.log('Prepared ephemeral production Wrangler configuration')
}
