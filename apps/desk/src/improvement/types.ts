import type { Actor } from '../domain/types'

declare const proposalRevisionBrand: unique symbol
export type ProposalRevision = string & { readonly [proposalRevisionBrand]: true }

export type ImprovementEvidence = {
  kind: 'operation_receipt'
  id: string
  revision?: string
}

export type EvaluationReport = {
  summary: string
  metrics: Record<string, string | number | boolean>
}

export type ImprovementEvaluation = {
  id: string
  suiteVersion: string
  passed: boolean
  report: EvaluationReport
  actor: Pick<Actor, 'id' | 'name' | 'email'> | null
  createdAt: string
}

export type ImprovementProposal = {
  kind: 'improvement_proposal'
  id: string
  scope: 'tenant' | 'product'
  artifactKind: 'playbook' | 'prompt' | 'policy' | 'tool' | 'context_compiler' | 'ontology' | 'model' | 'code'
  targetKey: string
  baseVersion: string
  candidateVersion: string
  status: 'proposed' | 'evaluated' | 'rejected' | 'withdrawn'
  evidence: ImprovementEvidence[]
  revision: ProposalRevision
  evaluations: ImprovementEvaluation[]
  createdBy: Pick<Actor, 'id' | 'name' | 'email'> | null
  createdAt: string
  updatedAt: string
}

export type ProposeImprovementCommand = {
  intentId: string
  scope: ImprovementProposal['scope']
  artifactKind: ImprovementProposal['artifactKind']
  targetKey: string
  baseVersion: string
  candidateVersion: string
  evidence: ImprovementEvidence[]
}

export type EvaluateImprovementCommand = {
  intentId: string
  proposalId: string
  revision: ProposalRevision
  suiteVersion: string
  passed: boolean
  report: EvaluationReport
}

export type ImprovementReceipt = {
  receiptId: string
  replayed: boolean
  proposal: ImprovementProposal
}

export interface ImprovementControl {
  work(actor: Actor, proposalId: string): Promise<ImprovementProposal>
  propose(actor: Actor, command: ProposeImprovementCommand): Promise<ImprovementReceipt>
  evaluate(actor: Actor, command: EvaluateImprovementCommand): Promise<ImprovementReceipt>
}
