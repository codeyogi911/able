import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { createProductionConfig, parseWranglerSource } from '../scripts/production-config.mjs'

const source = {
  name: 'able',
  d1_databases: [{ binding: 'DB', database_name: 'able', migrations_dir: 'migrations' }],
  r2_buckets: [{ binding: 'ATTACHMENTS' }],
  queues: {
    producers: [{ binding: 'MEDIA_QUEUE', queue: 'able-media' }],
    consumers: [{ queue: 'able-media', max_batch_size: 10 }],
  },
}

const variables = {
  ABLE_D1_DATABASE_ID: '00000000-0000-4000-8000-000000000001',
  ABLE_D1_DATABASE_NAME: 'able-production',
  ABLE_R2_BUCKET_NAME: 'able-production-attachments',
  ABLE_MEDIA_QUEUE_NAME: 'able-production-media',
}

describe('production Wrangler configuration', () => {
  it('projects private resource coordinates without mutating the reusable source', () => {
    const configured = createProductionConfig(source, variables)

    expect(configured.d1_databases[0]).toMatchObject({
      database_name: 'able-production',
      database_id: variables.ABLE_D1_DATABASE_ID,
    })
    expect(configured.r2_buckets[0]).toMatchObject({ bucket_name: 'able-production-attachments' })
    expect(configured.queues.producers[0]).toMatchObject({ queue: 'able-production-media' })
    expect(configured.queues.consumers[0]).toMatchObject({ queue: 'able-production-media' })
    expect(source.d1_databases[0]).not.toHaveProperty('database_id')
  })

  it('rejects missing or malformed production coordinates', () => {
    expect(() => createProductionConfig(source, { ...variables, ABLE_D1_DATABASE_ID: 'not-a-uuid' }))
      .toThrow('ABLE_D1_DATABASE_ID is missing or invalid')
    expect(() => createProductionConfig(source, { ...variables, ABLE_R2_BUCKET_NAME: '../bucket' }))
      .toThrow('ABLE_R2_BUCKET_NAME is missing or invalid')
  })

  it('keeps the committed Worker name unless a deployment supplies its own', () => {
    // A Worker cannot be renamed in place, so a deployment already serving
    // custom domains from an older Worker name must be able to keep it.
    expect(createProductionConfig(source, variables).name).toBe('able')
    expect(createProductionConfig(source, { ...variables, ABLE_WORKER_NAME: 'abledesk' }).name).toBe('abledesk')
    expect(createProductionConfig(source, { ...variables, ABLE_WORKER_NAME: '   ' }).name).toBe('able')
    expect(source.name).toBe('able')
  })

  it('rejects a Worker name Cloudflare would not accept', () => {
    for (const name of ['Not Valid', 'trailing-', '-leading', 'has_underscore', 'a'.repeat(64)]) {
      expect(() => createProductionConfig(source, { ...variables, ABLE_WORKER_NAME: name }))
        .toThrow('ABLE_WORKER_NAME is invalid')
    }
  })

  it('projects the committed wrangler.jsonc, comments included', async () => {
    // The committed configuration is JSONC, so the deploy path must accept
    // comments rather than assume plain JSON.
    const committed = parseWranglerSource(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
    const configured = createProductionConfig(committed, { ...variables, ABLE_WORKER_NAME: 'predecessor' })

    expect(configured.name).toBe('predecessor')
    expect(configured.d1_databases[0]).toMatchObject({
      binding: 'DB',
      database_name: variables.ABLE_D1_DATABASE_NAME,
      database_id: variables.ABLE_D1_DATABASE_ID,
    })
    expect(configured.r2_buckets[0]).toMatchObject({ bucket_name: variables.ABLE_R2_BUCKET_NAME })
    expect(configured.queues.producers[0].queue).toBe(variables.ABLE_MEDIA_QUEUE_NAME)
    expect(configured.queues.consumers[0].queue).toBe(variables.ABLE_MEDIA_QUEUE_NAME)
  })

  it('rejects source text that is not valid JSONC', () => {
    expect(() => parseWranglerSource('{ "name": ')).toThrow('wrangler.jsonc is not valid JSONC')
    expect(() => parseWranglerSource('[]')).toThrow('wrangler.jsonc is not valid JSONC')
  })
})
