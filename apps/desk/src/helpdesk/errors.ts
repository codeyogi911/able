export type HelpdeskErrorCode =
  | 'bad_request'
  | 'forbidden'
  | 'not_found'
  | 'stale_revision'
  | 'idempotency_conflict'
  | 'case_closed'
  | 'resource_not_found'
  | 'configuration_error'

export class HelpdeskError extends Error {
  readonly code: HelpdeskErrorCode
  readonly status: number

  constructor(code: HelpdeskErrorCode, message: string, status: number) {
    super(message)
    this.name = 'HelpdeskError'
    this.code = code
    this.status = status
  }
}

export function badRequest(message: string): never {
  throw new HelpdeskError('bad_request', message, 400)
}

export function notFound(message = 'Case not found'): never {
  throw new HelpdeskError('not_found', message, 404)
}
