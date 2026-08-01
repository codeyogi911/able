import { describe, expect, it } from 'vitest'

import { createProductionConfig } from '../scripts/production-config.mjs'

const source = {
  d1_databases: [{ binding: 'DB', database_name: 'morrow', migrations_dir: 'migrations' }],
  r2_buckets: [{ binding: 'ATTACHMENTS' }],
  queues: {
    producers: [{ binding: 'MEDIA_QUEUE', queue: 'morrow-media' }],
    consumers: [{ queue: 'morrow-media', max_batch_size: 10 }],
  },
}

const variables = {
  MORROW_D1_DATABASE_ID: '00000000-0000-4000-8000-000000000001',
  MORROW_D1_DATABASE_NAME: 'morrow-production',
  MORROW_R2_BUCKET_NAME: 'morrow-production-attachments',
  MORROW_MEDIA_QUEUE_NAME: 'morrow-production-media',
}

describe('production Wrangler configuration', () => {
  it('projects private resource coordinates without mutating the reusable source', () => {
    const configured = createProductionConfig(source, variables)

    expect(configured.d1_databases[0]).toMatchObject({
      database_name: 'morrow-production',
      database_id: variables.MORROW_D1_DATABASE_ID,
    })
    expect(configured.r2_buckets[0]).toMatchObject({ bucket_name: 'morrow-production-attachments' })
    expect(configured.queues.producers[0]).toMatchObject({ queue: 'morrow-production-media' })
    expect(configured.queues.consumers[0]).toMatchObject({ queue: 'morrow-production-media' })
    expect(source.d1_databases[0]).not.toHaveProperty('database_id')
  })

  it('rejects missing or malformed production coordinates', () => {
    expect(() => createProductionConfig(source, { ...variables, MORROW_D1_DATABASE_ID: 'not-a-uuid' }))
      .toThrow('MORROW_D1_DATABASE_ID is missing or invalid')
    expect(() => createProductionConfig(source, { ...variables, MORROW_R2_BUCKET_NAME: '../bucket' }))
      .toThrow('MORROW_R2_BUCKET_NAME is missing or invalid')
  })
})
