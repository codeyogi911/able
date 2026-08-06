import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createCrm } from '../src/crm'
import { createDirectory } from '../src/directory'
import type { Actor, CaseRef, CaseRevision, CaseWorkspace } from '../src/domain/types'
import { createCustomerWorkspace } from '../src/suite/customer-workspace'

const owner: Actor = {
  id: 'operator-owner',
  email: 'owner@example.com',
  name: 'Owner',
  role: 'admin',
}

const deskCase: CaseWorkspace = {
  kind: 'case',
  ref: 'AD-42' as CaseRef,
  revision: 'case-revision-7' as CaseRevision,
  subject: 'Machine stops during warm-up',
  status: 'open',
  priority: 'high',
  channel: 'email',
  category: { id: 'technical', name: 'Technical' },
  assignee: null,
  customer: {
    id: 'helpdesk-customer-42',
    name: 'Mina Customer',
    email: 'mina@example.test',
    phone: '+65 6123 4567',
    caseCount: 2,
  },
  thread: [],
  attachments: [],
  deliveryWarnings: [],
  kbSuggestions: [],
  openedAt: '2026-07-18T08:00:00.000Z',
  updatedAt: '2026-07-18T09:00:00.000Z',
}

describe('Customer workspace context contract', () => {
  it('keeps unresolved identity explicit until an authorized adoption command', async () => {
    let sequence = 0
    const random = { uuid: () => `context-test-id-${++sequence}` }
    const clock = { now: () => new Date('2026-07-18T14:00:00.000Z') }
    const directory = createDirectory({ db: env.DB, clock, random })
    const crm = createCrm({ db: env.DB, directory, clock, random })
    const helpdesk = {
      async work(_actor: Actor): Promise<CaseWorkspace> {
        return deskCase
      },
    }
    const customerWorkspace = createCustomerWorkspace({ helpdesk, directory, crm, clock })

    const unresolved = await customerWorkspace.load(owner, deskCase.ref)
    expect(unresolved).toMatchObject({
      schemaVersion: 'customer-workspace.v1',
      ontologyVersion: 'able-business.v1',
      kind: 'customer_workspace',
      asOf: '2026-07-18T14:00:00.000Z',
      subject: { caseRef: deskCase.ref, helpdeskCustomerId: deskCase.customer.id, partyId: null },
      revisions: { helpdesk: deskCase.revision, directory: null, crm: null },
      desk: deskCase,
      directory: null,
      crm: null,
      unknowns: ['directory_party_unresolved', 'crm_relationship_unavailable'],
      permittedActions: ['directory.adopt_helpdesk_customer'],
    })

    const adopted = await customerWorkspace.adoptHelpdeskCustomer(owner, {
      intentId: 'intent-adopt-context-customer',
      ref: deskCase.ref,
      revision: deskCase.revision,
    })

    expect(adopted.receipt).toMatchObject({ replayed: false, created: true })
    expect(adopted.workspace).toMatchObject({
      subject: { caseRef: deskCase.ref, partyId: adopted.receipt.party.id },
      revisions: {
        helpdesk: deskCase.revision,
        directory: adopted.receipt.party.revision,
        crm: null,
      },
      directory: adopted.receipt.party,
      crm: { kind: 'crm', partyId: adopted.receipt.party.id, relationship: null },
      unknowns: ['crm_relationship_not_started'],
      permittedActions: ['crm.manage_relationship'],
    })
  })
})
