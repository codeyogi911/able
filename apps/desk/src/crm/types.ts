import type { Actor } from '../domain/types'

declare const crmRevisionBrand: unique symbol
export type CrmRevision = string & { readonly [crmRevisionBrand]: true }

export type RelationshipStatus = 'lead' | 'prospect' | 'customer' | 'inactive'
export type SalesLeadStatus = 'new' | 'qualifying' | 'qualified' | 'disqualified' | 'converted'

export type CrmRelationship = {
  kind: 'crm_relationship'
  id: string
  partyId: string
  status: RelationshipStatus
  owner: Pick<Actor, 'id' | 'name' | 'email'> | null
  revision: CrmRevision
  createdAt: string
  updatedAt: string
}

export type CrmActivity = {
  id: string
  kind: 'note' | 'call' | 'email' | 'meeting' | 'support'
  summary: string
  occurredAt: string
  actor: Pick<Actor, 'id' | 'name' | 'email'> | null
  source?: { module: string; entityType: string; entityId: string }
  createdAt: string
}

export type CrmFollowUp = {
  id: string
  subject: string
  dueAt: string
  status: 'scheduled' | 'completed' | 'cancelled'
  owner: Pick<Actor, 'id' | 'name' | 'email'> | null
  revision: CrmRevision
  createdAt: string
  updatedAt: string
}

export type CrmSalesLead = {
  kind: 'sales_lead'
  id: string
  partyId: string
  title: string
  summary: string
  status: SalesLeadStatus
  owner: Pick<Actor, 'id' | 'name' | 'email'> | null
  source: { module: string; entityType: string; entityId: string }
  revision: CrmRevision
  createdAt: string
  updatedAt: string
}

export type CrmWorkspace = {
  kind: 'crm'
  partyId: string
  relationship: CrmRelationship | null
  salesLeads: CrmSalesLead[]
  activities: CrmActivity[]
  followUps: CrmFollowUp[]
}

export type CrmSelector = { kind: 'party'; partyId: string }

export type ManageRelationshipCommand = {
  kind: 'manage_relationship'
  intentId: string
  partyId: string
  revision?: CrmRevision
  status: RelationshipStatus
  ownerId?: string | null
}

export type RecordActivityCommand = {
  kind: 'record_activity'
  intentId: string
  partyId: string
  revision: CrmRevision
  activityKind: CrmActivity['kind']
  summary: string
  occurredAt: string
  source?: { module: string; entityType: string; entityId: string }
}

export type ScheduleFollowUpCommand = {
  kind: 'schedule_followup'
  intentId: string
  partyId: string
  revision: CrmRevision
  subject: string
  dueAt: string
  ownerId?: string | null
}

export type CreateSalesLeadCommand = {
  kind: 'create_sales_lead'
  intentId: string
  partyId: string
  title: string
  summary: string
  ownerId?: string | null
  source: { module: string; entityType: string; entityId: string }
}

export type CrmCommand = ManageRelationshipCommand | RecordActivityCommand | ScheduleFollowUpCommand | CreateSalesLeadCommand

type ReceiptBase = {
  operationId: string
  replayed: boolean
}

export type RelationshipReceipt = ReceiptBase & {
  relationship: CrmRelationship
}

export type ActivityReceipt = ReceiptBase & { activity: CrmActivity; relationshipRevision: CrmRevision }
export type FollowUpReceipt = ReceiptBase & { followUp: CrmFollowUp; relationshipRevision: CrmRevision }
export type SalesLeadReceipt = ReceiptBase & { salesLead: CrmSalesLead }
export type CrmReceipt = RelationshipReceipt | ActivityReceipt | FollowUpReceipt | SalesLeadReceipt

export interface Crm {
  work(actor: Actor, selector: CrmSelector): Promise<CrmWorkspace>
  salesLead(actor: Actor, selector: { kind: 'next' } | { kind: 'id'; id: string } | { kind: 'source'; source: { module: string; entityType: string; entityId: string } }): Promise<CrmSalesLead | null>
  act(actor: Actor, command: ManageRelationshipCommand): Promise<RelationshipReceipt>
  act(actor: Actor, command: RecordActivityCommand): Promise<ActivityReceipt>
  act(actor: Actor, command: ScheduleFollowUpCommand): Promise<FollowUpReceipt>
  act(actor: Actor, command: CreateSalesLeadCommand): Promise<SalesLeadReceipt>
}
