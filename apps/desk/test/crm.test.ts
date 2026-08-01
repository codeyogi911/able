import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createCrm } from '../src/crm'
import { createDirectory } from '../src/directory'
import type { Actor } from '../src/domain/types'

const owner: Actor = {
  id: 'operator-owner',
  email: 'owner@example.com',
  name: 'Owner',
  role: 'admin',
}

describe('CRM public contract', () => {
  it('creates a relationship for a Directory party and replays the same intent', async () => {
    let sequence = 0
    const random = { uuid: () => `crm-test-id-${++sequence}` }
    const clock = { now: () => new Date('2026-07-18T11:00:00.000Z') }
    const directory = createDirectory({ db: env.DB, clock, random })
    const adopted = await directory.act(owner, {
      kind: 'adopt_external',
      intentId: 'intent-adopt-crm-customer',
      source: { module: 'helpdesk', entityType: 'customer', entityId: 'customer-crm-1' },
      party: {
        kind: 'person',
        displayName: 'CRM Customer',
        contactPoints: [{ kind: 'email', value: 'crm-customer@example.test', primary: true }],
      },
    })
    const crm = createCrm({ db: env.DB, directory, clock, random })
    const command = {
      kind: 'manage_relationship' as const,
      intentId: 'intent-create-relationship-1',
      partyId: adopted.party.id,
      status: 'lead' as const,
      ownerId: owner.id,
    }

    const created = await crm.act(owner, command)
    const replay = await crm.act(owner, command)
    const workspace = await crm.work(owner, { kind: 'party', partyId: adopted.party.id })

    expect(created).toMatchObject({
      operationId: expect.stringMatching(/^op_/),
      replayed: false,
      relationship: {
        kind: 'crm_relationship',
        partyId: adopted.party.id,
        status: 'lead',
        owner: { id: owner.id, name: owner.name, email: owner.email },
        revision: expect.stringMatching(/^rev_/),
      },
    })
    expect(replay).toEqual({ ...created, replayed: true })
    expect(workspace).toEqual({
      kind: 'crm',
      partyId: adopted.party.id,
      relationship: created.relationship,
      salesLeads: [],
      activities: [],
      followUps: [],
    })
  })

  it('updates relationship state only from the latest opaque revision', async () => {
    let sequence = 0
    const random = { uuid: () => `crm-revision-test-id-${++sequence}` }
    const clock = { now: () => new Date('2026-07-18T12:00:00.000Z') }
    const directory = createDirectory({ db: env.DB, clock, random })
    const adopted = await directory.act(owner, {
      kind: 'adopt_external',
      intentId: 'intent-adopt-revision-customer',
      source: { module: 'helpdesk', entityType: 'customer', entityId: 'customer-crm-revision' },
      party: {
        kind: 'person',
        displayName: 'Revision Customer',
        contactPoints: [{ kind: 'email', value: 'revision@example.test', primary: true }],
      },
    })
    const crm = createCrm({ db: env.DB, directory, clock, random })
    const created = await crm.act(owner, {
      kind: 'manage_relationship',
      intentId: 'intent-create-revision-relationship',
      partyId: adopted.party.id,
      status: 'lead',
      ownerId: owner.id,
    })

    const updated = await crm.act(owner, {
      kind: 'manage_relationship',
      intentId: 'intent-promote-revision-relationship',
      partyId: adopted.party.id,
      revision: created.relationship.revision,
      status: 'customer',
      ownerId: null,
    })

    expect(updated.relationship).toMatchObject({
      id: created.relationship.id,
      status: 'customer',
      owner: null,
      revision: expect.stringMatching(/^rev_/),
    })
    expect(updated.relationship.revision).not.toBe(created.relationship.revision)
    await expect(crm.act(owner, {
      kind: 'manage_relationship',
      intentId: 'intent-stale-revision-relationship',
      partyId: adopted.party.id,
      revision: created.relationship.revision,
      status: 'inactive',
    })).rejects.toThrow('relationship changed')
  })

  it('records a sourced activity and schedules a follow-up as distinct receipts', async () => {
    let sequence = 0
    const random = { uuid: () => `crm-work-test-id-${++sequence}` }
    const clock = { now: () => new Date('2026-07-18T13:00:00.000Z') }
    const directory = createDirectory({ db: env.DB, clock, random })
    const adopted = await directory.act(owner, {
      kind: 'adopt_external',
      intentId: 'intent-adopt-work-customer',
      source: { module: 'helpdesk', entityType: 'customer', entityId: 'customer-crm-work' },
      party: {
        kind: 'person',
        displayName: 'Work Customer',
        contactPoints: [{ kind: 'email', value: 'work@example.test', primary: true }],
      },
    })
    const crm = createCrm({ db: env.DB, directory, clock, random })
    const relationship = await crm.act(owner, {
      kind: 'manage_relationship',
      intentId: 'intent-create-work-relationship',
      partyId: adopted.party.id,
      status: 'customer',
      ownerId: owner.id,
    })

    const activity = await crm.act(owner, {
      kind: 'record_activity',
      intentId: 'intent-record-support-activity',
      partyId: adopted.party.id,
      revision: relationship.relationship.revision,
      activityKind: 'support',
      summary: 'Diagnosed the warm-up issue and sent the safe startup steps.',
      occurredAt: '2026-07-18T12:55:00.000Z',
      source: { module: 'helpdesk', entityType: 'case', entityId: 'case-42' },
    })
    const followUp = await crm.act(owner, {
      kind: 'schedule_followup',
      intentId: 'intent-schedule-support-followup',
      partyId: adopted.party.id,
      revision: activity.relationshipRevision,
      subject: 'Confirm the machine completes warm-up',
      dueAt: '2026-07-20T09:00:00.000Z',
      ownerId: owner.id,
    })
    const workspace = await crm.work(owner, { kind: 'party', partyId: adopted.party.id })

    expect(activity).toMatchObject({
      operationId: expect.stringMatching(/^op_/),
      replayed: false,
      activity: {
        kind: 'support',
        summary: 'Diagnosed the warm-up issue and sent the safe startup steps.',
        actor: { id: owner.id, name: owner.name, email: owner.email },
        source: { module: 'helpdesk', entityType: 'case', entityId: 'case-42' },
      },
      relationshipRevision: expect.stringMatching(/^rev_/),
    })
    expect(followUp).toMatchObject({
      operationId: expect.stringMatching(/^op_/),
      replayed: false,
      followUp: {
        subject: 'Confirm the machine completes warm-up',
        dueAt: '2026-07-20T09:00:00.000Z',
        status: 'scheduled',
        owner: { id: owner.id, name: owner.name, email: owner.email },
        revision: expect.stringMatching(/^rev_/),
      },
      relationshipRevision: expect.stringMatching(/^rev_/),
    })
    expect(workspace.activities).toEqual([activity.activity])
    expect(workspace.followUps).toEqual([followUp.followUp])
    expect(workspace.relationship?.revision).toBe(followUp.relationshipRevision)
    expect(activity.relationshipRevision).not.toBe(relationship.relationship.revision)
    expect(followUp.relationshipRevision).not.toBe(activity.relationshipRevision)
  })
})
