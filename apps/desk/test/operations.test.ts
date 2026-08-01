import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createDirectory } from '../src/directory'
import type { Actor } from '../src/domain/types'
import { createOperationLoop } from '../src/operations'

const owner: Actor = {
  id: 'operator-owner',
  email: 'owner@example.com',
  name: 'Owner',
  role: 'admin',
}

describe('Operation closure contract', () => {
  it('closes only from an authoritative outcome observation', async () => {
    let sequence = 0
    const random = { uuid: () => `operation-test-id-${++sequence}` }
    const clock = { now: () => new Date('2026-07-18T15:00:00.000Z') }
    const directory = createDirectory({ db: env.DB, clock, random })
    const adopted = await directory.act(owner, {
      kind: 'adopt_external',
      intentId: 'intent-operation-subject',
      source: { module: 'helpdesk', entityType: 'customer', entityId: 'operation-customer' },
      party: {
        kind: 'person',
        displayName: 'Outcome Customer',
        contactPoints: [{ kind: 'email', value: 'outcome@example.test', primary: true }],
      },
    })
    const operations = createOperationLoop({ db: env.DB, clock, random })
    const contract = {
      name: 'customer-identity-confirmed.v1',
      intendedEffect: 'Confirm that the adopted party represents the support customer.',
      authoritativeSource: 'operator_confirmation',
      acceptedDefinition: 'The identity-adoption command was durably accepted.',
      deliveredDefinition: 'The canonical party and source link are readable.',
      successDefinition: 'An authorized operator verified the party against the source customer.',
      failureDefinition: 'The source customer is proven to represent a different party.',
      indeterminateDefinition: 'Available evidence cannot establish whether the identities correspond.',
      recoveryPolicy: 'human_review' as const,
      guardMetrics: ['identity.false_merge_rate'],
      notBefore: '2026-07-18T15:00:00.000Z',
      expiresAt: '2026-07-25T15:00:00.000Z',
    }
    const tracked = await operations.track(owner, {
      intentId: 'intent-track-directory-operation',
      operationId: adopted.operationId,
      contract,
    })
    const replay = await operations.track(owner, {
      intentId: 'intent-track-directory-operation',
      operationId: adopted.operationId,
      contract,
    })
    expect(replay).toEqual({ ...tracked, replayed: true })
    expect(tracked.closure).toMatchObject({
      operationId: adopted.operationId,
      status: 'pending',
      reconciliation: 'not_started',
      observations: [],
    })

    const telemetry = await operations.observe(owner, {
      intentId: 'intent-observe-telemetry-success',
      operationId: adopted.operationId,
      revision: tracked.closure.revision,
      source: 'runtime_telemetry',
      observedAt: '2026-07-18T15:05:00.000Z',
      result: 'succeeded',
      summary: 'The tool call returned without an error.',
    })
    expect(telemetry.observation.authoritative).toBe(false)
    expect(telemetry.closure).toMatchObject({ status: 'pending', reconciliation: 'pending' })

    const confirmed = await operations.observe(owner, {
      intentId: 'intent-observe-authoritative-success',
      operationId: adopted.operationId,
      revision: telemetry.closure.revision,
      source: 'operator_confirmation',
      sourceRevision: 'confirmation-1',
      observedAt: '2026-07-18T15:10:00.000Z',
      result: 'succeeded',
      summary: 'The operator verified the party against the source customer.',
    })
    expect(confirmed.observation.authoritative).toBe(true)
    expect(confirmed.closure).toMatchObject({ status: 'succeeded', reconciliation: 'reconciled' })

    const loaded = await operations.work(owner, adopted.operationId)
    expect(loaded).toEqual(confirmed.closure)
    expect(loaded.observations).toHaveLength(2)
  })

  it('expires a pending contract from server time without inventing an outcome observation', async () => {
    let sequence = 0
    let now = new Date('2026-07-18T15:00:00.000Z')
    const random = { uuid: () => `operation-expiry-test-id-${++sequence}` }
    const clock = { now: () => now }
    const directory = createDirectory({ db: env.DB, clock, random })
    const adopted = await directory.act(owner, {
      kind: 'adopt_external',
      intentId: 'intent-operation-expiry-subject',
      source: { module: 'helpdesk', entityType: 'customer', entityId: 'operation-expiry-customer' },
      party: { kind: 'person', displayName: 'Expiry Customer', contactPoints: [] },
    })
    const operations = createOperationLoop({ db: env.DB, clock, random })
    const tracked = await operations.track(owner, {
      intentId: 'intent-track-expiring-operation',
      operationId: adopted.operationId,
      contract: {
        name: 'customer-followup.v1',
        intendedEffect: 'Confirm that the customer follow-up happened.',
        authoritativeSource: 'operator_confirmation',
        acceptedDefinition: 'The follow-up was scheduled.',
        deliveredDefinition: 'The follow-up reached the customer channel.',
        successDefinition: 'The customer acknowledged the follow-up.',
        failureDefinition: 'The follow-up could not be completed.',
        indeterminateDefinition: 'No authoritative customer or operator evidence is available.',
        recoveryPolicy: 'human_review',
        guardMetrics: [],
        notBefore: '2026-07-18T15:00:00.000Z',
        expiresAt: '2026-07-19T15:00:00.000Z',
      },
    })

    await expect(operations.expire(owner, {
      intentId: 'intent-expire-operation-too-early',
      operationId: adopted.operationId,
      revision: tracked.closure.revision,
    })).rejects.toThrow('has not expired')

    now = new Date('2026-07-20T15:00:00.000Z')
    const expired = await operations.expire(owner, {
      intentId: 'intent-expire-operation',
      operationId: adopted.operationId,
      revision: tracked.closure.revision,
    })
    expect(expired.closure).toMatchObject({
      status: 'not_observable',
      reconciliation: 'reconciled',
      observations: [],
    })
    expect(expired.closure.revision).not.toBe(tracked.closure.revision)
  })
})
