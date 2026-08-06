import { describe, expect, it } from 'vitest'

import { createProductionConfig } from '../scripts/production-config.mjs'

const source = {
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
})
