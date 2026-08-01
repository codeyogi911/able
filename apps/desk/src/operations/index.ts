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
  ClosureRevision,
  ClosureStatus,
  ExpireOperationCommand,
  ExpireOperationReceipt,
  ObserveOperationCommand,
  ObserveOperationReceipt,
  ObservationResult,
  OperationClosure,
  OperationLoop,
  OutcomeObservation,
  ReconciliationStatus,
  RecoveryPolicy,
  TrackOperationCommand,
  TrackOperationReceipt,
} from './types'

export type {
  ClosureRevision,
  ClosureStatus,
  ExpireOperationCommand,
  ExpireOperationReceipt,
  ObserveOperationCommand,
  ObserveOperationReceipt,
  ObservationResult,
  OperationClosure,
  OperationLoop,
  OutcomeObservation,
  ReconciliationStatus,
  RecoveryPolicy,
  TrackOperationCommand,
  TrackOperationReceipt,
} from './types'

export type OperationLoopDependencies = {
  db: D1Database
  clock?: { now(): Date }
  random?: { uuid(): string }
}

type ClosureRow = {
  operation_id: string
  contract_name: string
  intended_effect: string
  authoritative_source: string
  accepted_definition: string
  delivered_definition: string
  success_definition: string
  failure_definition: string
  indeterminate_definition: string
  recovery_policy: RecoveryPolicy
  guard_metrics_json: string
  not_before: string
  expires_at: string
  status: ClosureStatus
  reconciliation: ReconciliationStatus
  revision: string
  created_at: string
  updated_at: string
}

type ObservationRow = {
  id: string
  source: string
  source_revision: string | null
  observed_at: string
  business_at: string | null
  result: ObservationResult
  authoritative: number
  within_window: number
  summary: string
  actor_id: string | null
  actor_name: string | null
  actor_email: string | null
  created_at: string
}

type ReceiptRow = { id: string; command_hash: string; result_json: string }
type StoredTrackReceipt = { closure: OperationClosure }
type StoredObserveReceipt = { observation: OutcomeObservation; closure: OperationClosure }
type StoredExpireReceipt = { closure: OperationClosure }

const TERMINAL = new Set<ClosureStatus>(['succeeded', 'failed', 'indeterminate', 'superseded', 'not_observable'])

function cleanGuardMetrics(values: string[]): string[] {
  if (values.length > 20) throw new Error('A closure contract may declare at most 20 guard metrics')
  return [...new Set(values.map((value) => clean(value, 'Guard metric', 160)))]
}

function terminalStatus(result: ObservationResult): ClosureStatus | null {
  if (result === 'succeeded' || result === 'failed' || result === 'indeterminate') return result
  return null
}

class D1OperationLoop implements OperationLoop {
  private readonly db: D1Database
  private readonly now: () => Date
  private readonly uuid: () => string

  constructor(dependencies: OperationLoopDependencies) {
    this.db = dependencies.db
    this.now = dependencies.clock?.now.bind(dependencies.clock) ?? (() => new Date())
    this.uuid = dependencies.random?.uuid.bind(dependencies.random) ?? defaultUuid
  }

  async work(actor: Actor, operationIdInput: string): Promise<OperationClosure> {
    await ensureOperator(this.db, actor, this.now)
    const closure = await this.load(clean(operationIdInput, 'Operation ID', 240))
    if (!closure) throw new Error('Tracked operation not found')
    return closure
  }

  async track(actor: Actor, input: TrackOperationCommand): Promise<TrackOperationReceipt> {
    const operator = await ensureOperator(this.db, actor, this.now)
    const command: TrackOperationCommand = {
      intentId: clean(input.intentId, 'Intent ID', 240),
      operationId: clean(input.operationId, 'Operation ID', 240),
      contract: {
        name: clean(input.contract.name, 'Closure contract name', 160),
        intendedEffect: clean(input.contract.intendedEffect, 'Intended effect', 2000),
        authoritativeSource: clean(input.contract.authoritativeSource, 'Authoritative source', 160).toLowerCase(),
        acceptedDefinition: clean(input.contract.acceptedDefinition, 'Accepted definition', 2000),
        deliveredDefinition: clean(input.contract.deliveredDefinition, 'Delivered definition', 2000),
        successDefinition: clean(input.contract.successDefinition, 'Success definition', 2000),
        failureDefinition: clean(input.contract.failureDefinition, 'Failure definition', 2000),
        indeterminateDefinition: clean(input.contract.indeterminateDefinition, 'Indeterminate definition', 2000),
        recoveryPolicy: input.contract.recoveryPolicy,
        guardMetrics: cleanGuardMetrics(input.contract.guardMetrics),
        notBefore: cleanIso(input.contract.notBefore, 'Observation start'),
        expiresAt: cleanIso(input.contract.expiresAt, 'Observation expiry'),
      },
    }
    if (command.contract.notBefore >= command.contract.expiresAt) {
      throw new Error('Observation expiry must be after its start')
    }
    const { commandHash, idempotencyKey, replay } = await this.commandIdentity(operator, command.intentId, command)
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different operation command')
      return { receiptId: replay.id, replayed: true, ...(JSON.parse(replay.result_json) as StoredTrackReceipt) }
    }
    const target = await this.db.prepare('SELECT id FROM operation_receipts WHERE id = ?').bind(command.operationId).first<{ id: string }>()
    if (!target) throw new Error('Operation receipt not found')
    if (await this.load(command.operationId)) throw new Error('Operation already has a closure contract')
    const now = this.now().toISOString()
    const receiptId = `op_${this.uuid()}`
    const closure: OperationClosure = {
      kind: 'operation_closure',
      operationId: command.operationId,
      contract: command.contract,
      status: 'pending',
      reconciliation: 'not_started',
      revision: `rev_${this.uuid()}` as ClosureRevision,
      observations: [],
      createdAt: now,
      updatedAt: now,
    }
    const stored: StoredTrackReceipt = { closure }
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO operation_closures
           (operation_id, contract_name, intended_effect, authoritative_source,
            accepted_definition, delivered_definition, success_definition, failure_definition,
            indeterminate_definition, recovery_policy, guard_metrics_json, not_before, expires_at,
            status, reconciliation, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'not_started', ?, ?, ?)`,
      ).bind(
        closure.operationId,
        closure.contract.name,
        closure.contract.intendedEffect,
        closure.contract.authoritativeSource,
        closure.contract.acceptedDefinition,
        closure.contract.deliveredDefinition,
        closure.contract.successDefinition,
        closure.contract.failureDefinition,
        closure.contract.indeterminateDefinition,
        closure.contract.recoveryPolicy,
        JSON.stringify(closure.contract.guardMetrics),
        closure.contract.notBefore,
        closure.contract.expiresAt,
        closure.revision,
        now,
        now,
      ),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         VALUES (?, 'operation_closure', ?, ?, 'operator', 'operation.closure_tracked', ?, ?)`,
      ).bind(`audit_${this.uuid()}`, closure.operationId, operator.id, JSON.stringify({ contract: closure.contract }), now),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         VALUES (?, ?, 'operation_loop', ?, 'operation_closure', ?, ?, ?, ?)`,
      ).bind(receiptId, idempotencyKey, operator.id, closure.operationId, commandHash, JSON.stringify(stored), now),
    ])
    return { receiptId, replayed: false, closure }
  }

  async observe(actor: Actor, input: ObserveOperationCommand): Promise<ObserveOperationReceipt> {
    const operator = await ensureOperator(this.db, actor, this.now)
    const command: ObserveOperationCommand = {
      intentId: clean(input.intentId, 'Intent ID', 240),
      operationId: clean(input.operationId, 'Operation ID', 240),
      revision: clean(input.revision, 'Closure revision', 240) as ClosureRevision,
      source: clean(input.source, 'Observation source', 160).toLowerCase(),
      ...(input.sourceRevision ? { sourceRevision: clean(input.sourceRevision, 'Source revision', 240) } : {}),
      observedAt: cleanIso(input.observedAt, 'Observed time'),
      ...(input.businessAt ? { businessAt: cleanIso(input.businessAt, 'Business time') } : {}),
      result: input.result,
      summary: clean(input.summary, 'Observation summary', 2000),
    }
    const { commandHash, idempotencyKey, replay } = await this.commandIdentity(operator, command.intentId, command)
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different operation command')
      return { receiptId: replay.id, replayed: true, ...(JSON.parse(replay.result_json) as StoredObserveReceipt) }
    }
    const current = await this.load(command.operationId)
    if (!current) throw new Error('Tracked operation not found')
    if (current.revision !== command.revision) throw new Error('The operation closure changed; load its latest revision and try again')
    const authoritative = command.source === current.contract.authoritativeSource
    const withinWindow = command.observedAt >= current.contract.notBefore && command.observedAt <= current.contract.expiresAt
    const now = this.now().toISOString()
    const observation: OutcomeObservation = {
      id: `observation_${this.uuid()}`,
      source: command.source,
      sourceRevision: command.sourceRevision ?? null,
      observedAt: command.observedAt,
      businessAt: command.businessAt ?? null,
      result: command.result,
      authoritative,
      withinWindow,
      summary: command.summary,
      actor: { id: operator.id, name: operator.name, email: operator.email },
      createdAt: now,
    }
    let status = current.status
    let reconciliation: ReconciliationStatus = 'pending'
    const observedTerminal = terminalStatus(observation.result)
    if (authoritative && withinWindow && observedTerminal) {
      if (TERMINAL.has(current.status) && current.status !== observedTerminal) {
        status = 'indeterminate'
        reconciliation = 'diverged'
      } else {
        status = observedTerminal
        reconciliation = 'reconciled'
      }
    } else if (TERMINAL.has(current.status)) {
      reconciliation = current.reconciliation
    }
    const revision = `rev_${this.uuid()}` as ClosureRevision
    const closure: OperationClosure = {
      ...current,
      status,
      reconciliation,
      revision,
      observations: [...current.observations, observation],
      updatedAt: now,
    }
    const receiptId = `op_${this.uuid()}`
    const stored: StoredObserveReceipt = { observation, closure }
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE operation_closures
         SET status = ?, reconciliation = ?, revision = ?, version = version + 1, updated_at = ?
         WHERE operation_id = ? AND revision = ?`,
      ).bind(status, reconciliation, revision, now, command.operationId, current.revision),
      this.db.prepare(
        `INSERT INTO operation_outcome_observations
           (id, operation_id, source, source_revision, observed_at, business_at, result,
            authoritative, within_window, summary, actor_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM operation_closures WHERE operation_id = ? AND revision = ?`,
      ).bind(
        observation.id,
        command.operationId,
        observation.source,
        observation.sourceRevision,
        observation.observedAt,
        observation.businessAt,
        observation.result,
        observation.authoritative ? 1 : 0,
        observation.withinWindow ? 1 : 0,
        observation.summary,
        operator.id,
        now,
        command.operationId,
        revision,
      ),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         SELECT ?, 'operation_closure', ?, ?, 'operator', 'operation.outcome_observed', ?, ?
         FROM operation_closures WHERE operation_id = ? AND revision = ?`,
      ).bind(`audit_${this.uuid()}`, command.operationId, operator.id, JSON.stringify({ observationId: observation.id, result: observation.result, authoritative, withinWindow }), now, command.operationId, revision),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         SELECT ?, ?, 'operation_loop', ?, 'operation_closure', ?, ?, ?, ?
         FROM operation_closures WHERE operation_id = ? AND revision = ?`,
      ).bind(receiptId, idempotencyKey, operator.id, command.operationId, commandHash, JSON.stringify(stored), now, command.operationId, revision),
    ])
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      throw new Error('The operation closure changed; load its latest revision and try again')
    }
    return { receiptId, replayed: false, observation, closure }
  }

  async expire(actor: Actor, input: ExpireOperationCommand): Promise<ExpireOperationReceipt> {
    const operator = await ensureOperator(this.db, actor, this.now)
    const command: ExpireOperationCommand = {
      intentId: clean(input.intentId, 'Intent ID', 240),
      operationId: clean(input.operationId, 'Operation ID', 240),
      revision: clean(input.revision, 'Closure revision', 240) as ClosureRevision,
    }
    const { commandHash, idempotencyKey, replay } = await this.commandIdentity(operator, command.intentId, command)
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different operation command')
      return { receiptId: replay.id, replayed: true, ...(JSON.parse(replay.result_json) as StoredExpireReceipt) }
    }
    const current = await this.load(command.operationId)
    if (!current) throw new Error('Tracked operation not found')
    if (current.revision !== command.revision) throw new Error('The operation closure changed; load its latest revision and try again')
    if (current.status !== 'pending') throw new Error('Only a pending operation closure can expire')
    const now = this.now().toISOString()
    if (now <= current.contract.expiresAt) throw new Error('The operation observation window has not expired')
    const revision = `rev_${this.uuid()}` as ClosureRevision
    const closure: OperationClosure = {
      ...current,
      status: 'not_observable',
      reconciliation: 'reconciled',
      revision,
      updatedAt: now,
    }
    const receiptId = `op_${this.uuid()}`
    const stored: StoredExpireReceipt = { closure }
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE operation_closures
         SET status = 'not_observable', reconciliation = 'reconciled', revision = ?,
             version = version + 1, updated_at = ?
         WHERE operation_id = ? AND revision = ? AND status = 'pending'`,
      ).bind(revision, now, command.operationId, current.revision),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         SELECT ?, 'operation_closure', ?, ?, 'operator', 'operation.closure_expired', ?, ?
         FROM operation_closures WHERE operation_id = ? AND revision = ?`,
      ).bind(`audit_${this.uuid()}`, command.operationId, operator.id, JSON.stringify({ expiresAt: current.contract.expiresAt }), now, command.operationId, revision),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         SELECT ?, ?, 'operation_loop', ?, 'operation_closure', ?, ?, ?, ?
         FROM operation_closures WHERE operation_id = ? AND revision = ?`,
      ).bind(receiptId, idempotencyKey, operator.id, command.operationId, commandHash, JSON.stringify(stored), now, command.operationId, revision),
    ])
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      throw new Error('The operation closure changed; load its latest revision and try again')
    }
    return { receiptId, replayed: false, closure }
  }

  private async commandIdentity(operator: Actor, intentId: string, command: unknown): Promise<{
    commandHash: string
    idempotencyKey: string
    replay: ReceiptRow | null
  }> {
    const commandHash = await sha256(stable(command))
    const idempotencyKey = await sha256(stable({ scope: 'operation_loop', actor: operator.id, intentId }))
    const replay = await this.db.prepare(
      'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first<ReceiptRow>()
    return { commandHash, idempotencyKey, replay }
  }

  private async load(operationId: string): Promise<OperationClosure | null> {
    const row = await this.db.prepare(
      `SELECT operation_id, contract_name, intended_effect, authoritative_source,
              accepted_definition, delivered_definition, success_definition, failure_definition,
              indeterminate_definition, recovery_policy, guard_metrics_json, not_before, expires_at,
              status, reconciliation, revision, created_at, updated_at
       FROM operation_closures WHERE operation_id = ?`,
    ).bind(operationId).first<ClosureRow>()
    if (!row) return null
    const observations = await this.db.prepare(
      `SELECT observation.id, observation.source, observation.source_revision, observation.observed_at,
              observation.business_at, observation.result, observation.authoritative,
              observation.within_window, observation.summary, observation.actor_id,
              actor.name AS actor_name, actor.email AS actor_email, observation.created_at
       FROM operation_outcome_observations observation
       LEFT JOIN operators actor ON actor.id = observation.actor_id
       WHERE observation.operation_id = ?
       ORDER BY observation.observed_at ASC, observation.id ASC`,
    ).bind(operationId).all<ObservationRow>()
    return {
      kind: 'operation_closure',
      operationId: row.operation_id,
      contract: {
        name: row.contract_name,
        intendedEffect: row.intended_effect,
        authoritativeSource: row.authoritative_source,
        acceptedDefinition: row.accepted_definition,
        deliveredDefinition: row.delivered_definition,
        successDefinition: row.success_definition,
        failureDefinition: row.failure_definition,
        indeterminateDefinition: row.indeterminate_definition,
        recoveryPolicy: row.recovery_policy,
        guardMetrics: JSON.parse(row.guard_metrics_json) as string[],
        notBefore: row.not_before,
        expiresAt: row.expires_at,
      },
      status: row.status,
      reconciliation: row.reconciliation,
      revision: row.revision as ClosureRevision,
      observations: observations.results.map((observation) => ({
        id: observation.id,
        source: observation.source,
        sourceRevision: observation.source_revision,
        observedAt: observation.observed_at,
        businessAt: observation.business_at,
        result: observation.result,
        authoritative: observation.authoritative === 1,
        withinWindow: observation.within_window === 1,
        summary: observation.summary,
        actor: observation.actor_id && observation.actor_name && observation.actor_email
          ? { id: observation.actor_id, name: observation.actor_name, email: observation.actor_email }
          : null,
        createdAt: observation.created_at,
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

export function createOperationLoop(dependencies: OperationLoopDependencies): OperationLoop {
  return new D1OperationLoop(dependencies)
}
