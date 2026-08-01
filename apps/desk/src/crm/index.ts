import type { Directory } from '../directory'
import type { Actor } from '../domain/types'
import {
  canonicalJson as stable,
  cleanIsoTimestamp as cleanIso,
  cleanText as clean,
  defaultUuid,
  ensureOperator,
  sha256Text as sha256,
} from '../platform/command-support'
import type {
  Crm,
  CrmActivity,
  CrmCommand,
  CrmFollowUp,
  CrmSalesLead,
  CrmReceipt,
  CrmRelationship,
  CrmRevision,
  CrmSelector,
  CrmWorkspace,
  CreateSalesLeadCommand,
  ActivityReceipt,
  FollowUpReceipt,
  ManageRelationshipCommand,
  RecordActivityCommand,
  RelationshipReceipt,
  RelationshipStatus,
  SalesLeadReceipt,
  SalesLeadStatus,
  ScheduleFollowUpCommand,
} from './types'

export type {
  Crm,
  CrmActivity,
  CrmCommand,
  CrmFollowUp,
  CrmSalesLead,
  CrmReceipt,
  CrmRelationship,
  CrmRevision,
  CrmSelector,
  CrmWorkspace,
  CreateSalesLeadCommand,
  ActivityReceipt,
  FollowUpReceipt,
  ManageRelationshipCommand,
  RecordActivityCommand,
  RelationshipReceipt,
  RelationshipStatus,
  SalesLeadReceipt,
  SalesLeadStatus,
  ScheduleFollowUpCommand,
} from './types'

export type CrmDependencies = {
  db: D1Database
  directory: Directory
  clock?: { now(): Date }
  random?: { uuid(): string }
}

type RelationshipRow = {
  id: string
  party_id: string
  status: RelationshipStatus
  owner_id: string | null
  revision: string
  created_at: string
  updated_at: string
  owner_name: string | null
  owner_email: string | null
}

type ReceiptRow = { id: string; command_hash: string; result_json: string }
type StoredRelationshipReceipt = { relationship: CrmRelationship }
type StoredActivityReceipt = { activity: CrmActivity; relationshipRevision: CrmRevision }
type StoredFollowUpReceipt = { followUp: CrmFollowUp; relationshipRevision: CrmRevision }
type StoredSalesLeadReceipt = { salesLead: CrmSalesLead }

type ActivityRow = {
  id: string
  kind: CrmActivity['kind']
  summary: string
  occurred_at: string
  actor_id: string | null
  actor_name: string | null
  actor_email: string | null
  source_module: string | null
  source_entity_type: string | null
  source_entity_id: string | null
  created_at: string
}

type FollowUpRow = {
  id: string
  subject: string
  due_at: string
  status: CrmFollowUp['status']
  owner_id: string | null
  owner_name: string | null
  owner_email: string | null
  revision: string
  created_at: string
  updated_at: string
}

type SalesLeadRow = {
  id: string
  party_id: string
  title: string
  summary: string
  status: SalesLeadStatus
  owner_id: string | null
  owner_name: string | null
  owner_email: string | null
  source_module: string
  source_entity_type: string
  source_entity_id: string
  revision: string
  created_at: string
  updated_at: string
}

class D1Crm implements Crm {
  private readonly db: D1Database
  private readonly directory: Directory
  private readonly now: () => Date
  private readonly uuid: () => string

  constructor(dependencies: CrmDependencies) {
    this.db = dependencies.db
    this.directory = dependencies.directory
    this.now = dependencies.clock?.now.bind(dependencies.clock) ?? (() => new Date())
    this.uuid = dependencies.random?.uuid.bind(dependencies.random) ?? defaultUuid
  }

  async work(actor: Actor, selector: CrmSelector): Promise<CrmWorkspace> {
    const operator = await ensureOperator(this.db, actor, this.now)
    const partyId = clean(selector.partyId, 'Party ID', 240)
    const party = await this.directory.work(operator, { kind: 'party', partyId })
    if (!party) throw new Error('Directory party not found')
    return this.loadWorkspace(partyId)
  }

  async salesLead(
    actor: Actor,
    selector: { kind: 'next' } | { kind: 'id'; id: string } | { kind: 'source'; source: { module: string; entityType: string; entityId: string } },
  ): Promise<CrmSalesLead | null> {
    const operator = await ensureOperator(this.db, actor, this.now)
    const base = `SELECT lead.id, lead.party_id, lead.title, lead.summary, lead.status, lead.owner_id,
                         owner.name AS owner_name, owner.email AS owner_email,
                         lead.source_module, lead.source_entity_type, lead.source_entity_id,
                         lead.revision, lead.created_at, lead.updated_at
                  FROM crm_sales_leads lead LEFT JOIN operators owner ON owner.id = lead.owner_id`
    let row: SalesLeadRow | null
    if (selector.kind === 'next') {
      row = await this.db.prepare(`${base} WHERE lead.status IN ('new', 'qualifying')
        AND (lead.owner_id IS NULL OR lead.owner_id = ?) ORDER BY lead.updated_at ASC, lead.id ASC LIMIT 1`)
        .bind(operator.id).first<SalesLeadRow>()
    } else if (selector.kind === 'id') {
      row = await this.db.prepare(`${base} WHERE lead.id = ?`).bind(clean(selector.id, 'Sales lead ID', 240)).first<SalesLeadRow>()
    } else {
      const source = {
        module: clean(selector.source.module, 'Source module', 80).toLowerCase(),
        entityType: clean(selector.source.entityType, 'Source entity type', 80).toLowerCase(),
        entityId: clean(selector.source.entityId, 'Source entity ID', 240),
      }
      row = await this.db.prepare(`${base} WHERE lead.source_module = ? AND lead.source_entity_type = ? AND lead.source_entity_id = ?`)
        .bind(source.module, source.entityType, source.entityId).first<SalesLeadRow>()
    }
    return row ? this.salesLeadFromRow(row) : null
  }

  async act(actor: Actor, input: ManageRelationshipCommand): Promise<RelationshipReceipt>
  async act(actor: Actor, input: RecordActivityCommand): Promise<ActivityReceipt>
  async act(actor: Actor, input: ScheduleFollowUpCommand): Promise<FollowUpReceipt>
  async act(actor: Actor, input: CreateSalesLeadCommand): Promise<SalesLeadReceipt>
  async act(actor: Actor, input: CrmCommand): Promise<CrmReceipt> {
    const operator = await ensureOperator(this.db, actor, this.now)
    if (input.kind === 'create_sales_lead') return this.createSalesLead(operator, input)
    if (input.kind === 'record_activity') return this.recordActivity(operator, input)
    if (input.kind === 'schedule_followup') return this.scheduleFollowUp(operator, input)
    return this.manageRelationship(operator, input)
  }

  private async createSalesLead(operator: Actor, input: CreateSalesLeadCommand): Promise<SalesLeadReceipt> {
    const command: CreateSalesLeadCommand = {
      kind: 'create_sales_lead',
      intentId: clean(input.intentId, 'Intent ID', 240),
      partyId: clean(input.partyId, 'Party ID', 240),
      title: clean(input.title, 'Sales lead title', 300),
      summary: clean(input.summary, 'Sales lead summary', 4_000),
      ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId === null ? null : clean(input.ownerId, 'Owner ID', 128) }),
      source: {
        module: clean(input.source.module, 'Source module', 80).toLowerCase(),
        entityType: clean(input.source.entityType, 'Source entity type', 80).toLowerCase(),
        entityId: clean(input.source.entityId, 'Source entity ID', 240),
      },
    }
    const commandHash = await sha256(stable(command))
    const idempotencyKey = await sha256(stable({ scope: 'crm', actor: operator.id, intentId: command.intentId }))
    const replay = await this.db.prepare(
      'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first<ReceiptRow>()
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different CRM command')
      return { operationId: replay.id, replayed: true, ...(JSON.parse(replay.result_json) as StoredSalesLeadReceipt) }
    }
    const party = await this.directory.work(operator, { kind: 'party', partyId: command.partyId })
    if (!party) throw new Error('Directory party not found')
    const owner = await this.requireOwner(command.ownerId === undefined ? operator.id : command.ownerId)
    const now = this.now().toISOString()
    const salesLead: CrmSalesLead = {
      kind: 'sales_lead',
      id: `lead_${this.uuid()}`,
      partyId: command.partyId,
      title: command.title,
      summary: command.summary,
      status: 'new',
      owner,
      source: command.source,
      revision: `rev_${this.uuid()}` as CrmRevision,
      createdAt: now,
      updatedAt: now,
    }
    const operationId = `op_${this.uuid()}`
    const stored: StoredSalesLeadReceipt = { salesLead }
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO crm_sales_leads
           (id, party_id, title, summary, status, owner_id, source_module, source_entity_type, source_entity_id,
            revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        salesLead.id,
        salesLead.partyId,
        salesLead.title,
        salesLead.summary,
        owner?.id ?? null,
        salesLead.source.module,
        salesLead.source.entityType,
        salesLead.source.entityId,
        salesLead.revision,
        now,
        now,
      ),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         VALUES (?, 'sales_lead', ?, ?, 'operator', 'crm.sales_lead_created', ?, ?)`,
      ).bind(
        `audit_${this.uuid()}`,
        salesLead.id,
        operator.id,
        JSON.stringify({ partyId: salesLead.partyId, source: salesLead.source, status: salesLead.status }),
        now,
      ),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         VALUES (?, ?, 'crm', ?, 'sales_lead', ?, ?, ?, ?)`,
      ).bind(operationId, idempotencyKey, operator.id, salesLead.id, commandHash, JSON.stringify(stored), now),
    ])
    return { operationId, replayed: false, salesLead }
  }

  private async manageRelationship(operator: Actor, input: ManageRelationshipCommand): Promise<RelationshipReceipt> {
    const command: ManageRelationshipCommand = {
      kind: 'manage_relationship',
      intentId: clean(input.intentId, 'Intent ID', 240),
      partyId: clean(input.partyId, 'Party ID', 240),
      ...(input.revision === undefined ? {} : { revision: clean(input.revision, 'Relationship revision', 240) as CrmRevision }),
      status: input.status,
      ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId === null ? null : clean(input.ownerId, 'Owner ID', 128) }),
    }
    const commandHash = await sha256(stable(command))
    const idempotencyKey = await sha256(stable({ scope: 'crm', actor: operator.id, intentId: command.intentId }))
    const replay = await this.db.prepare(
      'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first<ReceiptRow>()
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different CRM command')
      return { operationId: replay.id, replayed: true, ...(JSON.parse(replay.result_json) as StoredRelationshipReceipt) }
    }

    const party = await this.directory.work(operator, { kind: 'party', partyId: command.partyId })
    if (!party) throw new Error('Directory party not found')
    const existing = await this.relationshipRow(command.partyId)
    if (existing) {
      if (command.revision !== existing.revision) {
        throw new Error('The relationship changed; load the latest revision and try again')
      }
      const owner = await this.requireOwner(command.ownerId === undefined ? existing.owner_id : command.ownerId)
      const now = this.now().toISOString()
      const revision = `rev_${this.uuid()}`
      const operationId = `op_${this.uuid()}`
      const relationship: CrmRelationship = {
        kind: 'crm_relationship',
        id: existing.id,
        partyId: existing.party_id,
        status: command.status,
        owner,
        revision: revision as CrmRevision,
        createdAt: existing.created_at,
        updatedAt: now,
      }
      const stored: StoredRelationshipReceipt = { relationship }
      const results = await this.db.batch([
        this.db.prepare(
          `UPDATE crm_relationships
           SET status = ?, owner_id = ?, revision = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        ).bind(command.status, owner?.id ?? null, revision, now, existing.id, existing.revision),
        this.db.prepare(
          `INSERT INTO audit_events
             (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
           SELECT ?, 'crm_relationship', ?, ?, 'operator', 'crm.relationship_updated', ?, ?
           FROM crm_relationships WHERE id = ? AND revision = ?`,
        ).bind(
          `audit_${this.uuid()}`,
          existing.id,
          operator.id,
          JSON.stringify({ fromRevision: existing.revision, status: command.status, ownerId: owner?.id ?? null }),
          now,
          existing.id,
          revision,
        ),
        this.db.prepare(
          `INSERT INTO operation_receipts
             (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
           SELECT ?, ?, 'crm', ?, 'crm_relationship', ?, ?, ?, ?
           FROM crm_relationships WHERE id = ? AND revision = ?`,
        ).bind(
          operationId,
          idempotencyKey,
          operator.id,
          existing.id,
          commandHash,
          JSON.stringify(stored),
          now,
          existing.id,
          revision,
        ),
      ])
      if ((results[0]?.meta.changes ?? 0) !== 1) {
        throw new Error('The relationship changed; load the latest revision and try again')
      }
      return { operationId, replayed: false, relationship }
    }
    if (command.revision !== undefined) throw new Error('A new relationship must not include a revision')
    const owner = await this.requireOwner(command.ownerId === undefined ? operator.id : command.ownerId)
    const now = this.now().toISOString()
    const relationshipId = `relationship_${this.uuid()}`
    const revision = `rev_${this.uuid()}`
    const operationId = `op_${this.uuid()}`
    const relationship: CrmRelationship = {
      kind: 'crm_relationship',
      id: relationshipId,
      partyId: command.partyId,
      status: command.status,
      owner,
      revision: revision as CrmRevision,
      createdAt: now,
      updatedAt: now,
    }
    const stored: StoredRelationshipReceipt = { relationship }
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO crm_relationships
           (id, party_id, status, owner_id, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(relationshipId, command.partyId, command.status, owner?.id ?? null, revision, now, now),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         VALUES (?, 'crm_relationship', ?, ?, 'operator', 'crm.relationship_created', ?, ?)`,
      ).bind(`audit_${this.uuid()}`, relationshipId, operator.id, JSON.stringify({ partyId: command.partyId, status: command.status, ownerId: owner?.id ?? null }), now),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         VALUES (?, ?, 'crm', ?, 'crm_relationship', ?, ?, ?, ?)`,
      ).bind(operationId, idempotencyKey, operator.id, relationshipId, commandHash, JSON.stringify(stored), now),
    ])
    return { operationId, replayed: false, relationship }
  }

  private async recordActivity(operator: Actor, input: RecordActivityCommand): Promise<ActivityReceipt> {
    const command: RecordActivityCommand = {
      kind: 'record_activity',
      intentId: clean(input.intentId, 'Intent ID', 240),
      partyId: clean(input.partyId, 'Party ID', 240),
      revision: clean(input.revision, 'Relationship revision', 240) as CrmRevision,
      activityKind: input.activityKind,
      summary: clean(input.summary, 'Activity summary', 2000),
      occurredAt: cleanIso(input.occurredAt, 'Activity time'),
      ...(input.source
        ? {
            source: {
              module: clean(input.source.module, 'Source module', 80).toLowerCase(),
              entityType: clean(input.source.entityType, 'Source entity type', 80).toLowerCase(),
              entityId: clean(input.source.entityId, 'Source entity ID', 240),
            },
          }
        : {}),
    }
    const commandHash = await sha256(stable(command))
    const idempotencyKey = await sha256(stable({ scope: 'crm', actor: operator.id, intentId: command.intentId }))
    const replay = await this.db.prepare(
      'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first<ReceiptRow>()
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different CRM command')
      return { operationId: replay.id, replayed: true, ...(JSON.parse(replay.result_json) as StoredActivityReceipt) }
    }
    const relationship = await this.relationshipRow(command.partyId)
    if (!relationship) throw new Error('CRM relationship not found')
    if (relationship.revision !== command.revision) {
      throw new Error('The relationship changed; load the latest revision and try again')
    }
    const now = this.now().toISOString()
    const relationshipRevision = `rev_${this.uuid()}` as CrmRevision
    const activity: CrmActivity = {
      id: `activity_${this.uuid()}`,
      kind: command.activityKind,
      summary: command.summary,
      occurredAt: command.occurredAt,
      actor: { id: operator.id, name: operator.name, email: operator.email },
      ...(command.source ? { source: command.source } : {}),
      createdAt: now,
    }
    const operationId = `op_${this.uuid()}`
    const stored: StoredActivityReceipt = { activity, relationshipRevision }
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE crm_relationships
         SET revision = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
      ).bind(relationshipRevision, now, relationship.id, relationship.revision),
      this.db.prepare(
        `INSERT INTO crm_activities
           (id, relationship_id, kind, summary, occurred_at, actor_id,
            source_module, source_entity_type, source_entity_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM crm_relationships WHERE id = ? AND revision = ?`,
      ).bind(
        activity.id,
        relationship.id,
        activity.kind,
        activity.summary,
        activity.occurredAt,
        operator.id,
        command.source?.module ?? null,
        command.source?.entityType ?? null,
        command.source?.entityId ?? null,
        now,
        relationship.id,
        relationshipRevision,
      ),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         SELECT ?, 'crm_activity', ?, ?, 'operator', 'crm.activity_recorded', ?, ?
         FROM crm_relationships WHERE id = ? AND revision = ?`,
      ).bind(`audit_${this.uuid()}`, activity.id, operator.id, JSON.stringify({ relationshipId: relationship.id, relationshipRevision, source: command.source ?? null }), now, relationship.id, relationshipRevision),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         SELECT ?, ?, 'crm', ?, 'crm_activity', ?, ?, ?, ?
         FROM crm_relationships WHERE id = ? AND revision = ?`,
      ).bind(operationId, idempotencyKey, operator.id, activity.id, commandHash, JSON.stringify(stored), now, relationship.id, relationshipRevision),
    ])
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      throw new Error('The relationship changed; load the latest revision and try again')
    }
    return { operationId, replayed: false, activity, relationshipRevision }
  }

  private async scheduleFollowUp(operator: Actor, input: ScheduleFollowUpCommand): Promise<FollowUpReceipt> {
    const command: ScheduleFollowUpCommand = {
      kind: 'schedule_followup',
      intentId: clean(input.intentId, 'Intent ID', 240),
      partyId: clean(input.partyId, 'Party ID', 240),
      revision: clean(input.revision, 'Relationship revision', 240) as CrmRevision,
      subject: clean(input.subject, 'Follow-up subject', 500),
      dueAt: cleanIso(input.dueAt, 'Follow-up due time'),
      ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId === null ? null : clean(input.ownerId, 'Owner ID', 128) }),
    }
    const commandHash = await sha256(stable(command))
    const idempotencyKey = await sha256(stable({ scope: 'crm', actor: operator.id, intentId: command.intentId }))
    const replay = await this.db.prepare(
      'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first<ReceiptRow>()
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different CRM command')
      return { operationId: replay.id, replayed: true, ...(JSON.parse(replay.result_json) as StoredFollowUpReceipt) }
    }
    const relationship = await this.relationshipRow(command.partyId)
    if (!relationship) throw new Error('CRM relationship not found')
    if (relationship.revision !== command.revision) {
      throw new Error('The relationship changed; load the latest revision and try again')
    }
    const owner = await this.requireOwner(command.ownerId === undefined ? operator.id : command.ownerId)
    const now = this.now().toISOString()
    const followUp: CrmFollowUp = {
      id: `followup_${this.uuid()}`,
      subject: command.subject,
      dueAt: command.dueAt,
      status: 'scheduled',
      owner,
      revision: `rev_${this.uuid()}` as CrmRevision,
      createdAt: now,
      updatedAt: now,
    }
    const operationId = `op_${this.uuid()}`
    const relationshipRevision = `rev_${this.uuid()}` as CrmRevision
    const stored: StoredFollowUpReceipt = { followUp, relationshipRevision }
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE crm_relationships
         SET revision = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
      ).bind(relationshipRevision, now, relationship.id, relationship.revision),
      this.db.prepare(
        `INSERT INTO crm_followups
           (id, relationship_id, subject, due_at, status, owner_id, revision, created_at, updated_at)
         SELECT ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?
         FROM crm_relationships WHERE id = ? AND revision = ?`,
      ).bind(followUp.id, relationship.id, followUp.subject, followUp.dueAt, owner?.id ?? null, followUp.revision, now, now, relationship.id, relationshipRevision),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         SELECT ?, 'crm_followup', ?, ?, 'operator', 'crm.followup_scheduled', ?, ?
         FROM crm_relationships WHERE id = ? AND revision = ?`,
      ).bind(`audit_${this.uuid()}`, followUp.id, operator.id, JSON.stringify({ relationshipId: relationship.id, relationshipRevision, dueAt: followUp.dueAt, ownerId: owner?.id ?? null }), now, relationship.id, relationshipRevision),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         SELECT ?, ?, 'crm', ?, 'crm_followup', ?, ?, ?, ?
         FROM crm_relationships WHERE id = ? AND revision = ?`,
      ).bind(operationId, idempotencyKey, operator.id, followUp.id, commandHash, JSON.stringify(stored), now, relationship.id, relationshipRevision),
    ])
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      throw new Error('The relationship changed; load the latest revision and try again')
    }
    return { operationId, replayed: false, followUp, relationshipRevision }
  }

  private async requireOwner(ownerId: string | null): Promise<Pick<Actor, 'id' | 'name' | 'email'> | null> {
    if (ownerId === null) return null
    const owner = await this.db.prepare(
      'SELECT id, name, email FROM operators WHERE id = ? AND active = 1',
    ).bind(ownerId).first<Pick<Actor, 'id' | 'name' | 'email'>>()
    if (!owner) throw new Error('CRM owner is not an active operator')
    return owner
  }

  private relationshipRow(partyId: string): Promise<RelationshipRow | null> {
    return this.db.prepare(
      `SELECT relationship.id, relationship.party_id, relationship.status, relationship.owner_id,
              relationship.revision, relationship.created_at, relationship.updated_at,
              owner.name AS owner_name, owner.email AS owner_email
       FROM crm_relationships relationship
       LEFT JOIN operators owner ON owner.id = relationship.owner_id
       WHERE relationship.party_id = ?`,
    ).bind(partyId).first<RelationshipRow>()
  }

  private relationshipFromRow(row: RelationshipRow): CrmRelationship {
    return {
      kind: 'crm_relationship',
      id: row.id,
      partyId: row.party_id,
      status: row.status,
      owner: row.owner_id && row.owner_name && row.owner_email
        ? { id: row.owner_id, name: row.owner_name, email: row.owner_email }
        : null,
      revision: row.revision as CrmRevision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private salesLeadFromRow(lead: SalesLeadRow): CrmSalesLead {
    return {
      kind: 'sales_lead',
      id: lead.id,
      partyId: lead.party_id,
      title: lead.title,
      summary: lead.summary,
      status: lead.status,
      owner: lead.owner_id && lead.owner_name && lead.owner_email
        ? { id: lead.owner_id, name: lead.owner_name, email: lead.owner_email }
        : null,
      source: { module: lead.source_module, entityType: lead.source_entity_type, entityId: lead.source_entity_id },
      revision: lead.revision as CrmRevision,
      createdAt: lead.created_at,
      updatedAt: lead.updated_at,
    }
  }

  private async loadWorkspace(partyId: string): Promise<CrmWorkspace> {
    const row = await this.relationshipRow(partyId)
    const salesLeads = await this.db.prepare(
      `SELECT lead.id, lead.party_id, lead.title, lead.summary, lead.status, lead.owner_id,
              owner.name AS owner_name, owner.email AS owner_email,
              lead.source_module, lead.source_entity_type, lead.source_entity_id,
              lead.revision, lead.created_at, lead.updated_at
       FROM crm_sales_leads lead
       LEFT JOIN operators owner ON owner.id = lead.owner_id
       WHERE lead.party_id = ? ORDER BY lead.updated_at DESC, lead.id DESC`,
    ).bind(partyId).all<SalesLeadRow>()
    const mappedSalesLeads = salesLeads.results.map((lead) => this.salesLeadFromRow(lead))
    if (!row) return { kind: 'crm', partyId, relationship: null, salesLeads: mappedSalesLeads, activities: [], followUps: [] }
    const [activities, followUps] = await Promise.all([
      this.db.prepare(
        `SELECT activity.id, activity.kind, activity.summary, activity.occurred_at,
                activity.actor_id, actor.name AS actor_name, actor.email AS actor_email,
                activity.source_module, activity.source_entity_type, activity.source_entity_id,
                activity.created_at
         FROM crm_activities activity
         LEFT JOIN operators actor ON actor.id = activity.actor_id
         WHERE activity.relationship_id = ?
         ORDER BY activity.occurred_at DESC, activity.id DESC`,
      ).bind(row.id).all<ActivityRow>(),
      this.db.prepare(
        `SELECT followup.id, followup.subject, followup.due_at, followup.status,
                followup.owner_id, owner.name AS owner_name, owner.email AS owner_email,
                followup.revision, followup.created_at, followup.updated_at
         FROM crm_followups followup
         LEFT JOIN operators owner ON owner.id = followup.owner_id
         WHERE followup.relationship_id = ?
         ORDER BY followup.due_at ASC, followup.id ASC`,
      ).bind(row.id).all<FollowUpRow>(),
    ])
    return {
      kind: 'crm',
      partyId,
      relationship: this.relationshipFromRow(row),
      salesLeads: mappedSalesLeads,
      activities: activities.results.map((activity) => ({
        id: activity.id,
        kind: activity.kind,
        summary: activity.summary,
        occurredAt: activity.occurred_at,
        actor: activity.actor_id && activity.actor_name && activity.actor_email
          ? { id: activity.actor_id, name: activity.actor_name, email: activity.actor_email }
          : null,
        ...(activity.source_module && activity.source_entity_type && activity.source_entity_id
          ? { source: { module: activity.source_module, entityType: activity.source_entity_type, entityId: activity.source_entity_id } }
          : {}),
        createdAt: activity.created_at,
      })),
      followUps: followUps.results.map((followUp) => ({
        id: followUp.id,
        subject: followUp.subject,
        dueAt: followUp.due_at,
        status: followUp.status,
        owner: followUp.owner_id && followUp.owner_name && followUp.owner_email
          ? { id: followUp.owner_id, name: followUp.owner_name, email: followUp.owner_email }
          : null,
        revision: followUp.revision as CrmRevision,
        createdAt: followUp.created_at,
        updatedAt: followUp.updated_at,
      })),
    }
  }
}

export function createCrm(dependencies: CrmDependencies): Crm {
  return new D1Crm(dependencies)
}
