import type { Crm, CrmWorkspace } from '../crm'
import type { Directory, DirectoryReceipt, PartyWorkspace } from '../directory'
import type { Actor, CaseWorkspace, Helpdesk } from '../domain/types'
import { ABLE_ONTOLOGY_VERSION } from '../ontology/v1'

export type CustomerWorkspace = {
  schemaVersion: 'customer-workspace.v1'
  ontologyVersion: typeof ABLE_ONTOLOGY_VERSION
  kind: 'customer_workspace'
  asOf: string
  subject: {
    caseRef: string
    helpdeskCustomerId: string
    partyId: string | null
  }
  revisions: {
    helpdesk: string
    directory: string | null
    crm: string | null
  }
  desk: CaseWorkspace
  directory: PartyWorkspace | null
  crm: CrmWorkspace | null
  unknowns: Array<
    | 'directory_party_unresolved'
    | 'crm_relationship_unavailable'
    | 'crm_relationship_not_started'
  >
  permittedActions: Array<
    | 'directory.adopt_helpdesk_customer'
    | 'crm.manage_relationship'
    | 'crm.record_activity'
    | 'crm.schedule_followup'
  >
  evidence: Array<{
    module: 'helpdesk' | 'directory' | 'crm'
    subjectType: 'case' | 'party' | 'crm_relationship'
    subjectId: string
    revision: string
  }>
}

export type CustomerWorkspaceDependencies = {
  helpdesk: Pick<Helpdesk, 'work'>
  directory: Directory
  crm: Crm
  clock?: { now(): Date }
}

export type AdoptHelpdeskCustomerCommand = {
  intentId: string
  ref: string
  revision: string
}

export interface CustomerWorkspaceService {
  load(actor: Actor, ref: string): Promise<CustomerWorkspace>
  adoptHelpdeskCustomer(
    actor: Actor,
    command: AdoptHelpdeskCustomerCommand,
  ): Promise<{ receipt: DirectoryReceipt; workspace: CustomerWorkspace }>
}

function clean(value: string, label: string, maximum: number): string {
  const cleaned = value.replaceAll('\u0000', '').trim()
  if (!cleaned) throw new Error(`${label} is required`)
  if (cleaned.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer`)
  return cleaned
}

class ComposedCustomerWorkspace implements CustomerWorkspaceService {
  private readonly helpdesk: Pick<Helpdesk, 'work'>
  private readonly directory: Directory
  private readonly crm: Crm
  private readonly now: () => Date

  constructor(dependencies: CustomerWorkspaceDependencies) {
    this.helpdesk = dependencies.helpdesk
    this.directory = dependencies.directory
    this.crm = dependencies.crm
    this.now = dependencies.clock?.now.bind(dependencies.clock) ?? (() => new Date())
  }

  async load(actor: Actor, refInput: string): Promise<CustomerWorkspace> {
    const desk = await this.loadDeskCase(actor, refInput)
    return this.compose(actor, desk)
  }

  async adoptHelpdeskCustomer(
    actor: Actor,
    commandInput: AdoptHelpdeskCustomerCommand,
  ): Promise<{ receipt: DirectoryReceipt; workspace: CustomerWorkspace }> {
    const command = {
      intentId: clean(commandInput.intentId, 'Intent ID', 240),
      ref: clean(commandInput.ref, 'Case reference', 128),
      revision: clean(commandInput.revision, 'Case revision', 240),
    }
    const desk = await this.loadDeskCase(actor, command.ref)
    if (desk.revision !== command.revision) {
      throw new Error('The case changed; load the latest revision before adopting its customer')
    }
    const receipt = await this.directory.act(actor, {
      kind: 'adopt_external',
      intentId: command.intentId,
      source: {
        module: 'helpdesk',
        entityType: 'customer',
        entityId: desk.customer.id,
      },
      party: {
        kind: 'person',
        displayName: desk.customer.name,
        contactPoints: [
          ...(desk.customer.email
            ? [{ kind: 'email' as const, value: desk.customer.email, primary: true }]
            : []),
          ...(desk.customer.phone
            ? [{ kind: 'phone' as const, value: desk.customer.phone, primary: !desk.customer.email }]
            : []),
        ],
      },
    })
    return { receipt, workspace: await this.compose(actor, desk) }
  }

  private async loadDeskCase(actor: Actor, refInput: string): Promise<CaseWorkspace> {
    const ref = clean(refInput, 'Case reference', 128)
    const result = await this.helpdesk.work(actor, { kind: 'case', ref })
    if (result.kind !== 'case') throw new Error('Helpdesk case not found')
    return result
  }

  private async compose(actor: Actor, desk: CaseWorkspace): Promise<CustomerWorkspace> {
    const party = await this.directory.work(actor, {
      kind: 'external',
      source: { module: 'helpdesk', entityType: 'customer', entityId: desk.customer.id },
    })
    if (!party) {
      return {
        schemaVersion: 'customer-workspace.v1',
        ontologyVersion: ABLE_ONTOLOGY_VERSION,
        kind: 'customer_workspace',
        asOf: this.now().toISOString(),
        subject: { caseRef: desk.ref, helpdeskCustomerId: desk.customer.id, partyId: null },
        revisions: { helpdesk: desk.revision, directory: null, crm: null },
        desk,
        directory: null,
        crm: null,
        unknowns: ['directory_party_unresolved', 'crm_relationship_unavailable'],
        permittedActions: ['directory.adopt_helpdesk_customer'],
        evidence: [{ module: 'helpdesk', subjectType: 'case', subjectId: desk.ref, revision: desk.revision }],
      }
    }
    const crm = await this.crm.work(actor, { kind: 'party', partyId: party.id })
    return {
      schemaVersion: 'customer-workspace.v1',
      ontologyVersion: ABLE_ONTOLOGY_VERSION,
      kind: 'customer_workspace',
      asOf: this.now().toISOString(),
      subject: { caseRef: desk.ref, helpdeskCustomerId: desk.customer.id, partyId: party.id },
      revisions: {
        helpdesk: desk.revision,
        directory: party.revision,
        crm: crm.relationship?.revision ?? null,
      },
      desk,
      directory: party,
      crm,
      unknowns: crm.relationship ? [] : ['crm_relationship_not_started'],
      permittedActions: crm.relationship
        ? ['crm.manage_relationship', 'crm.record_activity', 'crm.schedule_followup']
        : ['crm.manage_relationship'],
      evidence: [
        { module: 'helpdesk', subjectType: 'case', subjectId: desk.ref, revision: desk.revision },
        { module: 'directory', subjectType: 'party', subjectId: party.id, revision: party.revision },
        ...(crm.relationship
          ? [{
              module: 'crm' as const,
              subjectType: 'crm_relationship' as const,
              subjectId: crm.relationship.id,
              revision: crm.relationship.revision,
            }]
          : []),
      ],
    }
  }
}

export function createCustomerWorkspace(dependencies: CustomerWorkspaceDependencies): CustomerWorkspaceService {
  return new ComposedCustomerWorkspace(dependencies)
}
