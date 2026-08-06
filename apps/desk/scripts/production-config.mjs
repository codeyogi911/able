import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(repositoryRoot, 'wrangler.jsonc')
const outputPath = resolve(repositoryRoot, 'wrangler.production.generated.json')

function required(env, name, pattern) {
  const value = env[name]?.trim()
  if (!value || !pattern.test(value)) throw new Error(`${name} is missing or invalid`)
  return value
}

export function createProductionConfig(source, env) {
  const databaseId = required(env, 'ABLE_D1_DATABASE_ID', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  const databaseName = required(env, 'ABLE_D1_DATABASE_NAME', /^[a-z0-9][a-z0-9_-]{1,62}$/)
  const bucketName = required(env, 'ABLE_R2_BUCKET_NAME', /^[a-z0-9][a-z0-9_-]{1,62}$/)
  const queueName = required(env, 'ABLE_MEDIA_QUEUE_NAME', /^[a-z0-9][a-z0-9_-]{1,62}$/)
  const config = structuredClone(source)

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
  const source = JSON.parse(await readFile(sourcePath, 'utf8'))
  const production = createProductionConfig(source, process.env)
  await writeFile(outputPath, `${JSON.stringify(production, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  console.log('Prepared ephemeral production Wrangler configuration')
}
