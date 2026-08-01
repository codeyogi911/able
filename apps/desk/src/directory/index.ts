import type { Actor } from '../domain/types'
import {
  canonicalJson as stable,
  cleanText as clean,
  defaultUuid,
  ensureOperator,
  sha256Text as sha256,
} from '../platform/command-support'
import type {
  ContactPointKind,
  Directory,
  DirectoryCommand,
  DirectoryReceipt,
  DirectorySelector,
  ExternalIdentity,
  PartyKind,
  PartyRevision,
  PartyWorkspace,
} from './types'

export type {
  ContactPointKind,
  Directory,
  DirectoryCommand,
  DirectoryReceipt,
  DirectorySelector,
  ExternalIdentity,
  PartyKind,
  PartyRevision,
  PartyWorkspace,
} from './types'

export type DirectoryDependencies = {
  db: D1Database
  clock?: { now(): Date }
  random?: { uuid(): string }
}

type PartyRow = {
  id: string
  kind: PartyKind
  display_name: string
  revision: string
  created_at: string
  updated_at: string
}

type ReceiptRow = {
  id: string
  command_hash: string
  result_json: string
}

type StoredReceipt = {
  created: boolean
  partyId: string
}

function cleanSource(source: ExternalIdentity): ExternalIdentity {
  return {
    module: clean(source.module, 'Source module', 80).toLowerCase(),
    entityType: clean(source.entityType, 'Source entity type', 80).toLowerCase(),
    entityId: clean(source.entityId, 'Source entity ID', 240),
  }
}

function cleanContact(kind: ContactPointKind, value: string): string {
  const cleaned = clean(value, kind === 'email' ? 'Email' : 'Phone', kind === 'email' ? 320 : 80)
  if (kind === 'email') {
    const normalized = cleaned.toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('Email is invalid')
    return normalized
  }
  return cleaned
}

class D1Directory implements Directory {
  private readonly db: D1Database
  private readonly now: () => Date
  private readonly uuid: () => string

  constructor(dependencies: DirectoryDependencies) {
    this.db = dependencies.db
    this.now = dependencies.clock?.now.bind(dependencies.clock) ?? (() => new Date())
    this.uuid = dependencies.random?.uuid.bind(dependencies.random) ?? defaultUuid
  }

  async work(actor: Actor, selector: DirectorySelector): Promise<PartyWorkspace | null> {
    await ensureOperator(this.db, actor, this.now)
    if (selector.kind === 'party') return this.loadParty(clean(selector.partyId, 'Party ID', 240))
    const source = cleanSource(selector.source)
    const row = await this.db.prepare(
      `SELECT party_id FROM directory_external_links
       WHERE source_module = ? AND source_entity_type = ? AND source_entity_id = ?`,
    ).bind(source.module, source.entityType, source.entityId).first<{ party_id: string }>()
    return row ? this.loadParty(row.party_id) : null
  }

  async act(actor: Actor, input: DirectoryCommand): Promise<DirectoryReceipt> {
    const operator = await ensureOperator(this.db, actor, this.now)
    if (input.kind === 'link_external') return this.linkExternal(operator, input)
    const source = cleanSource(input.source)
    const contactPoints = input.party.contactPoints.map((contact) => ({
      kind: contact.kind,
      value: cleanContact(contact.kind, contact.value),
      primary: contact.primary === true,
    }))
    if (contactPoints.length > 20) throw new Error('A party may have at most 20 contact points')
    const command: DirectoryCommand = {
      kind: 'adopt_external',
      intentId: clean(input.intentId, 'Intent ID', 240),
      source,
      party: {
        kind: input.party.kind,
        displayName: clean(input.party.displayName, 'Display name', 240),
        contactPoints,
      },
    }
    const commandHash = await sha256(stable(command))
    const idempotencyKey = await sha256(stable({ scope: 'directory', actor: operator.id, intentId: command.intentId }))
    const replay = await this.db.prepare(
      'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first<ReceiptRow>()
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different Directory command')
      const stored = JSON.parse(replay.result_json) as StoredReceipt
      const party = await this.loadParty(stored.partyId)
      if (!party) throw new Error('Directory receipt points to a missing party')
      return { operationId: replay.id, replayed: true, created: stored.created, party }
    }

    const existing = await this.db.prepare(
      `SELECT party_id FROM directory_external_links
       WHERE source_module = ? AND source_entity_type = ? AND source_entity_id = ?`,
    ).bind(source.module, source.entityType, source.entityId).first<{ party_id: string }>()
    const now = this.now().toISOString()
    const operationId = `op_${this.uuid()}`
    if (existing) {
      const party = await this.loadParty(existing.party_id)
      if (!party) throw new Error('Linked Directory party is missing')
      const stored: StoredReceipt = { created: false, partyId: party.id }
      await this.db.batch([
        this.db.prepare(
          `INSERT INTO audit_events
             (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
           VALUES (?, 'party', ?, ?, 'operator', 'directory.external_link_reused', ?, ?)`,
        ).bind(`audit_${this.uuid()}`, party.id, operator.id, JSON.stringify({ source }), now),
        this.db.prepare(
          `INSERT INTO operation_receipts
             (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
           VALUES (?, ?, 'directory', ?, 'party', ?, ?, ?, ?)`,
        ).bind(operationId, idempotencyKey, operator.id, party.id, commandHash, JSON.stringify(stored), now),
      ])
      return { operationId, replayed: false, created: false, party }
    }

    const partyId = `party_${this.uuid()}`
    const revision = `rev_${this.uuid()}`
    const linkId = `link_${this.uuid()}`
    const contacts = contactPoints.map((contact) => ({ id: `contact_${this.uuid()}`, ...contact }))
    const party: PartyWorkspace = {
      kind: 'party',
      id: partyId,
      partyKind: command.party.kind,
      displayName: command.party.displayName,
      revision: revision as PartyRevision,
      contactPoints: contacts.map((contact) => ({
        id: contact.id,
        kind: contact.kind,
        value: contact.value,
        primary: contact.primary,
      })),
      externalLinks: [source],
      createdAt: now,
      updatedAt: now,
    }
    const stored: StoredReceipt = { created: true, partyId }
    const statements: D1PreparedStatement[] = [
      this.db.prepare(
        `INSERT INTO directory_parties
           (id, kind, display_name, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(partyId, command.party.kind, command.party.displayName, revision, now, now),
      ...contacts.map((contact) => this.db.prepare(
        `INSERT INTO directory_contact_points
           (id, party_id, kind, value, normalized_value, is_primary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(contact.id, partyId, contact.kind, contact.value, contact.value, contact.primary ? 1 : 0, now)),
      this.db.prepare(
        `INSERT INTO directory_external_links
           (id, party_id, source_module, source_entity_type, source_entity_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(linkId, partyId, source.module, source.entityType, source.entityId, now),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         VALUES (?, 'party', ?, ?, 'operator', 'directory.party_adopted', ?, ?)`,
      ).bind(`audit_${this.uuid()}`, partyId, operator.id, JSON.stringify({ source, contactPointCount: contactPoints.length }), now),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         VALUES (?, ?, 'directory', ?, 'party', ?, ?, ?, ?)`,
      ).bind(operationId, idempotencyKey, operator.id, partyId, commandHash, JSON.stringify(stored), now),
    ]
    await this.db.batch(statements)
    return { operationId, replayed: false, created: true, party }
  }

  private async linkExternal(
    operator: Actor,
    input: Extract<DirectoryCommand, { kind: 'link_external' }>,
  ): Promise<DirectoryReceipt> {
    const command = {
      kind: 'link_external' as const,
      intentId: clean(input.intentId, 'Intent ID', 240),
      source: cleanSource(input.source),
      partyId: clean(input.partyId, 'Party ID', 240),
    }
    const commandHash = await sha256(stable(command))
    const idempotencyKey = await sha256(stable({ scope: 'directory', actor: operator.id, intentId: command.intentId }))
    const replay = await this.db.prepare(
      'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first<ReceiptRow>()
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different Directory command')
      const stored = JSON.parse(replay.result_json) as StoredReceipt
      const party = await this.loadParty(stored.partyId)
      if (!party) throw new Error('Directory receipt points to a missing party')
      return { operationId: replay.id, replayed: true, created: false, party }
    }
    const party = await this.loadParty(command.partyId)
    if (!party) throw new Error('Directory party not found')
    const existing = await this.db.prepare(
      `SELECT party_id FROM directory_external_links
       WHERE source_module = ? AND source_entity_type = ? AND source_entity_id = ?`,
    ).bind(command.source.module, command.source.entityType, command.source.entityId).first<{ party_id: string }>()
    if (existing && existing.party_id !== party.id) throw new Error('External identity is already linked to a different Party')
    const now = this.now().toISOString()
    const revision = `rev_${this.uuid()}` as PartyRevision
    const operationId = `op_${this.uuid()}`
    const stored: StoredReceipt = { created: false, partyId: party.id }
    const statements: D1PreparedStatement[] = []
    if (!existing) statements.push(
      this.db.prepare(
        `INSERT INTO directory_external_links
           (id, party_id, source_module, source_entity_type, source_entity_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(`link_${this.uuid()}`, party.id, command.source.module, command.source.entityType, command.source.entityId, now),
    )
    statements.push(
      this.db.prepare(
        'UPDATE directory_parties SET revision = ?, version = version + 1, updated_at = ? WHERE id = ?',
      ).bind(revision, now, party.id),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         VALUES (?, 'party', ?, ?, 'operator', 'directory.external_linked', ?, ?)`,
      ).bind(`audit_${this.uuid()}`, party.id, operator.id, JSON.stringify({ source: command.source }), now),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         VALUES (?, ?, 'directory', ?, 'party', ?, ?, ?, ?)`,
      ).bind(operationId, idempotencyKey, operator.id, party.id, commandHash, JSON.stringify(stored), now),
    )
    await this.db.batch(statements)
    const updated = await this.loadParty(party.id)
    if (!updated) throw new Error('Linked Directory party could not be loaded')
    return { operationId, replayed: false, created: false, party: updated }
  }

  private async loadParty(partyId: string): Promise<PartyWorkspace | null> {
    const row = await this.db.prepare(
      'SELECT id, kind, display_name, revision, created_at, updated_at FROM directory_parties WHERE id = ?',
    ).bind(partyId).first<PartyRow>()
    if (!row) return null
    const [contacts, links] = await Promise.all([
      this.db.prepare(
        `SELECT id, kind, value, is_primary FROM directory_contact_points
         WHERE party_id = ? ORDER BY created_at ASC, id ASC`,
      ).bind(row.id).all<{ id: string; kind: ContactPointKind; value: string; is_primary: number }>(),
      this.db.prepare(
        `SELECT source_module, source_entity_type, source_entity_id FROM directory_external_links
         WHERE party_id = ? ORDER BY created_at ASC, id ASC`,
      ).bind(row.id).all<{ source_module: string; source_entity_type: string; source_entity_id: string }>(),
    ])
    return {
      kind: 'party',
      id: row.id,
      partyKind: row.kind,
      displayName: row.display_name,
      revision: row.revision as PartyRevision,
      contactPoints: contacts.results.map((contact) => ({
        id: contact.id,
        kind: contact.kind,
        value: contact.value,
        primary: contact.is_primary === 1,
      })),
      externalLinks: links.results.map((link) => ({
        module: link.source_module,
        entityType: link.source_entity_type,
        entityId: link.source_entity_id,
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

export function createDirectory(dependencies: DirectoryDependencies): Directory {
  return new D1Directory(dependencies)
}
