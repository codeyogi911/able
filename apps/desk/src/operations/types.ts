import type { Actor } from '../domain/types'

declare const closureRevisionBrand: unique symbol
export type ClosureRevision = string & { readonly [closureRevisionBrand]: true }

export type ClosureStatus = 'pending' | 'succeeded' | 'failed' | 'indeterminate' | 'superseded' | 'not_observable'
export type ReconciliationStatus = 'not_started' | 'pending' | 'reconciled' | 'diverged'
export type ObservationResult = 'accepted' | 'delivered' | 'succeeded' | 'failed' | 'indeterminate'
export type RecoveryPolicy = 'no_retry' | 'idempotent_retry' | 'compensate' | 'human_review'

export type OutcomeObservation = {
  id: string
  source: string
  sourceRevision: string | null
  observedAt: string
  businessAt: string | null
  result: ObservationResult
  authoritative: boolean
  withinWindow: boolean
  summary: string
  actor: Pick<Actor, 'id' | 'name' | 'email'> | null
  createdAt: string
}

export type OperationClosure = {
  kind: 'operation_closure'
  operationId: string
  contract: {
    name: string
    intendedEffect: string
    authoritativeSource: string
    acceptedDefinition: string
    deliveredDefinition: string
    successDefinition: string
    failureDefinition: string
    indeterminateDefinition: string
    recoveryPolicy: RecoveryPolicy
    guardMetrics: string[]
    notBefore: string
    expiresAt: string
  }
  status: ClosureStatus
  reconciliation: ReconciliationStatus
  revision: ClosureRevision
  observations: OutcomeObservation[]
  createdAt: string
  updatedAt: string
}

export type TrackOperationCommand = {
  intentId: string
  operationId: string
  contract: OperationClosure['contract']
}

export type ObserveOperationCommand = {
  intentId: string
  operationId: string
  revision: ClosureRevision
  source: string
  sourceRevision?: string
  observedAt: string
  businessAt?: string
  result: ObservationResult
  summary: string
}

export type ExpireOperationCommand = {
  intentId: string
  operationId: string
  revision: ClosureRevision
}

export type TrackOperationReceipt = {
  receiptId: string
  replayed: boolean
  closure: OperationClosure
}

export type ObserveOperationReceipt = {
  receiptId: string
  replayed: boolean
  observation: OutcomeObservation
  closure: OperationClosure
}

export type ExpireOperationReceipt = {
  receiptId: string
  replayed: boolean
  closure: OperationClosure
}

export interface OperationLoop {
  work(actor: Actor, operationId: string): Promise<OperationClosure>
  track(actor: Actor, command: TrackOperationCommand): Promise<TrackOperationReceipt>
  observe(actor: Actor, command: ObserveOperationCommand): Promise<ObserveOperationReceipt>
  expire(actor: Actor, command: ExpireOperationCommand): Promise<ExpireOperationReceipt>
}
