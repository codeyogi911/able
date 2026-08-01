import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Actor } from '../src/domain/types'
import { createDirectory } from '../src/directory'

const owner: Actor = {
  id: 'operator-owner',
  email: 'owner@example.com',
  name: 'Owner',
  role: 'admin',
}

describe('Directory public contract', () => {
  it('adopts a module identity explicitly and replays the same intent', async () => {
    let sequence = 0
    const directory = createDirectory({
      db: env.DB,
      clock: { now: () => new Date('2026-07-18T10:00:00.000Z') },
      random: { uuid: () => `directory-test-id-${++sequence}` },
    })
    const command = {
      kind: 'adopt_external' as const,
      intentId: 'intent-adopt-customer-1',
      source: { module: 'helpdesk', entityType: 'customer', entityId: 'customer-1' },
      party: {
        kind: 'person' as const,
        displayName: 'Mina Customer',
        contactPoints: [
          { kind: 'email' as const, value: 'MINA@example.test', primary: true },
          { kind: 'phone' as const, value: '+65 6123 4567', primary: true },
        ],
      },
    }

    const created = await directory.act(owner, command)
    const replay = await directory.act(owner, command)
    const loaded = await directory.work(owner, {
      kind: 'external',
      source: command.source,
    })

    expect(created).toMatchObject({
      operationId: expect.stringMatching(/^op_/),
      replayed: false,
      created: true,
      party: {
        kind: 'party',
        partyKind: 'person',
        displayName: 'Mina Customer',
        revision: expect.stringMatching(/^rev_/),
        contactPoints: [
          { kind: 'email', value: 'mina@example.test', primary: true },
          { kind: 'phone', value: '+65 6123 4567', primary: true },
        ],
        externalLinks: [command.source],
      },
    })
    expect(replay).toEqual({ ...created, replayed: true })
    expect(loaded).toEqual(created.party)
  })

  it('does not auto-merge different source identities that share a contact point', async () => {
    let sequence = 0
    const directory = createDirectory({
      db: env.DB,
      clock: { now: () => new Date('2026-07-18T10:30:00.000Z') },
      random: { uuid: () => `directory-torture-id-${++sequence}` },
    })
    const first = await directory.act(owner, {
      kind: 'adopt_external',
      intentId: 'intent-adopt-shared-email-first',
      source: { module: 'helpdesk', entityType: 'customer', entityId: 'shared-email-1' },
      party: {
        kind: 'person',
        displayName: 'First Source Identity',
        contactPoints: [{ kind: 'email', value: 'shared@example.test', primary: true }],
      },
    })
    const second = await directory.act(owner, {
      kind: 'adopt_external',
      intentId: 'intent-adopt-shared-email-second',
      source: { module: 'helpdesk', entityType: 'customer', entityId: 'shared-email-2' },
      party: {
        kind: 'person',
        displayName: 'Second Source Identity',
        contactPoints: [{ kind: 'email', value: 'shared@example.test', primary: true }],
      },
    })

    expect(second.party.id).not.toBe(first.party.id)
    expect(second.party.externalLinks).toEqual([
      { module: 'helpdesk', entityType: 'customer', entityId: 'shared-email-2' },
    ])
  })

  it('never reports two successful Parties for one concurrently linked external identity', async () => {
    const directory = createDirectory({ db: env.DB })
    const create = (suffix: string) => directory.act(owner, {
      kind: 'adopt_external' as const,
      intentId: `create-party-${suffix}`,
      source: { module: 'test', entityType: 'seed', entityId: suffix },
      party: {
        kind: 'person' as const,
        displayName: `Party ${suffix}`,
        contactPoints: [{ kind: 'phone' as const, value: `+1555000${suffix}`, primary: true }],
      },
    })
    const first = await create('101')
    const second = await create('202')
    const source = { module: 'communications', entityType: 'contact', entityId: 'stable-contact' }
    const results = await Promise.allSettled([
      directory.act(owner, { kind: 'link_external', intentId: 'link-first', source, partyId: first.party.id }),
      directory.act(owner, { kind: 'link_external', intentId: 'link-second', source, partyId: second.party.id }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const linked = await directory.work(owner, { kind: 'external', source })
    const fulfilled = results.find((result) => result.status === 'fulfilled')
    if (!fulfilled || fulfilled.status !== 'fulfilled') throw new Error('Expected one successful link')
    expect(linked?.id).toBe(fulfilled.value.party.id)
  })
})
