import type { Actor } from '../domain/types'
import {
  canonicalJson as stable,
  cleanText as clean,
  defaultUuid,
  ensureOperator,
  sha256Text as sha256,
} from '../platform/command-support'
import type {
  EvaluateImprovementCommand,
  EvaluationReport,
  ImprovementControl,
  ImprovementEvaluation,
  ImprovementEvidence,
  ImprovementProposal,
  ImprovementReceipt,
  ProposalRevision,
  ProposeImprovementCommand,
} from './types'

export type {
  EvaluateImprovementCommand,
  EvaluationReport,
  ImprovementControl,
  ImprovementEvaluation,
  ImprovementEvidence,
  ImprovementProposal,
  ImprovementReceipt,
  ProposalRevision,
  ProposeImprovementCommand,
} from './types'

export type ImprovementControlDependencies = {
  db: D1Database
  clock?: { now(): Date }
  random?: { uuid(): string }
}

type ProposalRow = {
  id: string
  scope: ImprovementProposal['scope']
  artifact_kind: ImprovementProposal['artifactKind']
  target_key: string
  base_version: string
  candidate_version: string
  status: ImprovementProposal['status']
  evidence_json: string
  revision: string
  created_by: string | null
  creator_name: string | null
  creator_email: string | null
  created_at: string
  updated_at: string
}

type EvaluationRow = {
  id: string
  suite_version: string
  passed: number
  report_json: string
  actor_id: string | null
  actor_name: string | null
  actor_email: string | null
  created_at: string
}

type ReceiptRow = { id: string; command_hash: string; result_json: string }
type StoredReceipt = { proposal: ImprovementProposal }

function cleanEvidence(evidence: ImprovementEvidence[]): ImprovementEvidence[] {
  if (evidence.length === 0 || evidence.length > 50) throw new Error('Improvement evidence must contain between 1 and 50 coordinates')
  return evidence.map((item) => ({
    kind: item.kind,
    id: clean(item.id, 'Evidence ID', 240),
    ...(item.revision ? { revision: clean(item.revision, 'Evidence revision', 240) } : {}),
  }))
}

function cleanReport(report: EvaluationReport): EvaluationReport {
  const metrics: EvaluationReport['metrics'] = {}
  for (const [key, value] of Object.entries(report.metrics)) {
    const cleanedKey = clean(key, 'Metric name', 160)
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Metric ${cleanedKey} must be finite`)
    if (typeof value === 'string') metrics[cleanedKey] = clean(value, `Metric ${cleanedKey}`, 500)
    else if (typeof value === 'number' || typeof value === 'boolean') metrics[cleanedKey] = value
    else throw new Error(`Metric ${cleanedKey} has an unsupported value`)
  }
  return { summary: clean(report.summary, 'Evaluation summary', 4000), metrics }
}

class D1ImprovementControl implements ImprovementControl {
  private readonly db: D1Database
  private readonly now: () => Date
  private readonly uuid: () => string

  constructor(dependencies: ImprovementControlDependencies) {
    this.db = dependencies.db
    this.now = dependencies.clock?.now.bind(dependencies.clock) ?? (() => new Date())
    this.uuid = dependencies.random?.uuid.bind(dependencies.random) ?? defaultUuid
  }

  async work(actor: Actor, proposalIdInput: string): Promise<ImprovementProposal> {
    await ensureOperator(this.db, actor, this.now)
    const proposal = await this.load(clean(proposalIdInput, 'Proposal ID', 240))
    if (!proposal) throw new Error('Improvement proposal not found')
    return proposal
  }

  async propose(actor: Actor, input: ProposeImprovementCommand): Promise<ImprovementReceipt> {
    const operator = await ensureOperator(this.db, actor, this.now)
    const command: ProposeImprovementCommand = {
      intentId: clean(input.intentId, 'Intent ID', 240),
      scope: input.scope,
      artifactKind: input.artifactKind,
      targetKey: clean(input.targetKey, 'Improvement target', 240),
      baseVersion: clean(input.baseVersion, 'Base version', 240),
      candidateVersion: clean(input.candidateVersion, 'Candidate version', 240),
      evidence: cleanEvidence(input.evidence),
    }
    if (command.baseVersion === command.candidateVersion) throw new Error('Candidate version must differ from the base version')
    for (const evidence of command.evidence) {
      if (evidence.kind !== 'operation_receipt') continue
      const exists = await this.db.prepare('SELECT id FROM operation_receipts WHERE id = ?').bind(evidence.id).first<{ id: string }>()
      if (!exists) throw new Error(`Evidence operation receipt ${evidence.id} was not found`)
    }
    const { commandHash, idempotencyKey, replay } = await this.commandIdentity(operator, command.intentId, command)
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different improvement command')
      return { receiptId: replay.id, replayed: true, ...(JSON.parse(replay.result_json) as StoredReceipt) }
    }
    const now = this.now().toISOString()
    const proposal: ImprovementProposal = {
      kind: 'improvement_proposal',
      id: `proposal_${this.uuid()}`,
      scope: command.scope,
      artifactKind: command.artifactKind,
      targetKey: command.targetKey,
      baseVersion: command.baseVersion,
      candidateVersion: command.candidateVersion,
      status: 'proposed',
      evidence: command.evidence,
      revision: `rev_${this.uuid()}` as ProposalRevision,
      evaluations: [],
      createdBy: { id: operator.id, name: operator.name, email: operator.email },
      createdAt: now,
      updatedAt: now,
    }
    const receiptId = `op_${this.uuid()}`
    const stored: StoredReceipt = { proposal }
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO improvement_proposals
           (id, scope, artifact_kind, target_key, base_version, candidate_version, status,
            evidence_json, revision, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`,
      ).bind(proposal.id, proposal.scope, proposal.artifactKind, proposal.targetKey, proposal.baseVersion, proposal.candidateVersion, JSON.stringify(proposal.evidence), proposal.revision, operator.id, now, now),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         VALUES (?, 'improvement_proposal', ?, ?, 'operator', 'improvement.proposed', ?, ?)`,
      ).bind(`audit_${this.uuid()}`, proposal.id, operator.id, JSON.stringify({ scope: proposal.scope, artifactKind: proposal.artifactKind, targetKey: proposal.targetKey, evidenceCount: proposal.evidence.length }), now),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         VALUES (?, ?, 'improvement', ?, 'improvement_proposal', ?, ?, ?, ?)`,
      ).bind(receiptId, idempotencyKey, operator.id, proposal.id, commandHash, JSON.stringify(stored), now),
    ])
    return { receiptId, replayed: false, proposal }
  }

  async evaluate(actor: Actor, input: EvaluateImprovementCommand): Promise<ImprovementReceipt> {
    const operator = await ensureOperator(this.db, actor, this.now)
    if (operator.role !== 'admin') throw new Error('Admin access required to record an improvement evaluation')
    const command: EvaluateImprovementCommand = {
      intentId: clean(input.intentId, 'Intent ID', 240),
      proposalId: clean(input.proposalId, 'Proposal ID', 240),
      revision: clean(input.revision, 'Proposal revision', 240) as ProposalRevision,
      suiteVersion: clean(input.suiteVersion, 'Evaluation suite version', 240),
      passed: input.passed,
      report: cleanReport(input.report),
    }
    const { commandHash, idempotencyKey, replay } = await this.commandIdentity(operator, command.intentId, command)
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different improvement command')
      return { receiptId: replay.id, replayed: true, ...(JSON.parse(replay.result_json) as StoredReceipt) }
    }
    const current = await this.load(command.proposalId)
    if (!current) throw new Error('Improvement proposal not found')
    if (current.revision !== command.revision) throw new Error('The improvement proposal changed; load its latest revision and try again')
    if (current.status !== 'proposed') throw new Error('Only a proposed improvement can be evaluated')
    if (current.createdBy?.id === operator.id) {
      throw new Error('A different administrator must record the independent improvement evaluation')
    }
    const now = this.now().toISOString()
    const evaluation: ImprovementEvaluation = {
      id: `evaluation_${this.uuid()}`,
      suiteVersion: command.suiteVersion,
      passed: command.passed,
      report: command.report,
      actor: { id: operator.id, name: operator.name, email: operator.email },
      createdAt: now,
    }
    const revision = `rev_${this.uuid()}` as ProposalRevision
    const proposal: ImprovementProposal = {
      ...current,
      status: command.passed ? 'evaluated' : 'rejected',
      revision,
      evaluations: [...current.evaluations, evaluation],
      updatedAt: now,
    }
    const receiptId = `op_${this.uuid()}`
    const stored: StoredReceipt = { proposal }
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE improvement_proposals
         SET status = ?, revision = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND revision = ? AND status = 'proposed'`,
      ).bind(proposal.status, revision, now, proposal.id, current.revision),
      this.db.prepare(
        `INSERT INTO improvement_evaluations
           (id, proposal_id, suite_version, passed, report_json, actor_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         FROM improvement_proposals WHERE id = ? AND revision = ?`,
      ).bind(evaluation.id, proposal.id, evaluation.suiteVersion, evaluation.passed ? 1 : 0, JSON.stringify(evaluation.report), operator.id, now, proposal.id, revision),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         SELECT ?, 'improvement_proposal', ?, ?, 'operator', 'improvement.evaluated', ?, ?
         FROM improvement_proposals WHERE id = ? AND revision = ?`,
      ).bind(`audit_${this.uuid()}`, proposal.id, operator.id, JSON.stringify({ evaluationId: evaluation.id, suiteVersion: evaluation.suiteVersion, passed: evaluation.passed }), now, proposal.id, revision),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         SELECT ?, ?, 'improvement', ?, 'improvement_proposal', ?, ?, ?, ?
         FROM improvement_proposals WHERE id = ? AND revision = ?`,
      ).bind(receiptId, idempotencyKey, operator.id, proposal.id, commandHash, JSON.stringify(stored), now, proposal.id, revision),
    ])
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      throw new Error('The improvement proposal changed; load its latest revision and try again')
    }
    return { receiptId, replayed: false, proposal }
  }

  private async commandIdentity(operator: Actor, intentId: string, command: unknown): Promise<{
    commandHash: string
    idempotencyKey: string
    replay: ReceiptRow | null
  }> {
    const commandHash = await sha256(stable(command))
    const idempotencyKey = await sha256(stable({ scope: 'improvement', actor: operator.id, intentId }))
    const replay = await this.db.prepare(
      'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first<ReceiptRow>()
    return { commandHash, idempotencyKey, replay }
  }

  private async load(proposalId: string): Promise<ImprovementProposal | null> {
    const row = await this.db.prepare(
      `SELECT proposal.id, proposal.scope, proposal.artifact_kind, proposal.target_key,
              proposal.base_version, proposal.candidate_version, proposal.status,
              proposal.evidence_json, proposal.revision, proposal.created_by,
              creator.name AS creator_name, creator.email AS creator_email,
              proposal.created_at, proposal.updated_at
       FROM improvement_proposals proposal
       LEFT JOIN operators creator ON creator.id = proposal.created_by
       WHERE proposal.id = ?`,
    ).bind(proposalId).first<ProposalRow>()
    if (!row) return null
    const evaluations = await this.db.prepare(
      `SELECT evaluation.id, evaluation.suite_version, evaluation.passed, evaluation.report_json,
              evaluation.actor_id, actor.name AS actor_name, actor.email AS actor_email,
              evaluation.created_at
       FROM improvement_evaluations evaluation
       LEFT JOIN operators actor ON actor.id = evaluation.actor_id
       WHERE evaluation.proposal_id = ?
       ORDER BY evaluation.created_at ASC, evaluation.id ASC`,
    ).bind(proposalId).all<EvaluationRow>()
    return {
      kind: 'improvement_proposal',
      id: row.id,
      scope: row.scope,
      artifactKind: row.artifact_kind,
      targetKey: row.target_key,
      baseVersion: row.base_version,
      candidateVersion: row.candidate_version,
      status: row.status,
      evidence: JSON.parse(row.evidence_json) as ImprovementEvidence[],
      revision: row.revision as ProposalRevision,
      evaluations: evaluations.results.map((evaluation) => ({
        id: evaluation.id,
        suiteVersion: evaluation.suite_version,
        passed: evaluation.passed === 1,
        report: JSON.parse(evaluation.report_json) as EvaluationReport,
        actor: evaluation.actor_id && evaluation.actor_name && evaluation.actor_email
          ? { id: evaluation.actor_id, name: evaluation.actor_name, email: evaluation.actor_email }
          : null,
        createdAt: evaluation.created_at,
      })),
      createdBy: row.created_by && row.creator_name && row.creator_email
        ? { id: row.created_by, name: row.creator_name, email: row.creator_email }
        : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

export function createImprovementControl(dependencies: ImprovementControlDependencies): ImprovementControl {
  return new D1ImprovementControl(dependencies)
}
