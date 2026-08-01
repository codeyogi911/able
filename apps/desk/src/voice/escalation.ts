export const ESCALATION_CATEGORIES = [
  'explicit_human_request',
  'safety_risk',
  'account_security',
  'payment_or_refund',
  'privacy_or_legal',
  'repeated_failure',
] as const

export type EscalationCategory = typeof ESCALATION_CATEGORIES[number]

export const HUMAN_HELP_MESSAGE = 'Please let me speak to a real person.'

const TICKET_STATUS_INTENT = /\b(?:status|update|progress|where\s+(?:is|are)|what(?:'s|\s+is)\s+happening)\b/i
const TICKET_STATUS_STATE = /\b(?:has|have|did|is|are|was|were)\b.{0,50}\b(?:process(?:ed)?|approv(?:ed)?|complet(?:e|ed)|resolv(?:e|ed)|clos(?:e|ed)|ship(?:ped)?|sent|updated)\b/i
const TICKET_NOUN = /\b(?:ticket|case|request|refund|return|claim)\b/i

export function isTicketStatusRequest(transcript: string): boolean {
  return TICKET_NOUN.test(transcript) && (TICKET_STATUS_INTENT.test(transcript) || TICKET_STATUS_STATE.test(transcript))
}

const CATEGORY_LABELS: Record<EscalationCategory, string> = {
  explicit_human_request: 'Customer asked for a person',
  safety_risk: 'Potential safety issue',
  account_security: 'Account security concern',
  payment_or_refund: 'Payment or refund review',
  privacy_or_legal: 'Privacy or legal request',
  repeated_failure: 'Repeated troubleshooting failure',
}

const ESCALATION_RULES: Array<{ category: EscalationCategory; pattern: RegExp }> = [
  { category: 'explicit_human_request', pattern: /\b(human|real person|live agent|representative|supervisor|manager|someone on (?:the )?phone)\b/i },
  { category: 'safety_risk', pattern: /\b(smok(?:e|ing)|fire|burning|spark(?:s|ing)?|electric shock|injur(?:y|ed)|unsafe|gas leak|medical emergency)\b/i },
  { category: 'account_security', pattern: /\b(hack(?:ed|ing)?|unauthori[sz]ed|fraud|stolen (?:account|card)|someone (?:else )?(?:accessed|logged)|account takeover|security breach)\b/i },
  { category: 'payment_or_refund', pattern: /\b(refund|charged twice|double charg(?:e|ed)|wrong charge|payment dispute|chargeback|billing error)\b/i },
  { category: 'privacy_or_legal', pattern: /\b(delete my data|privacy request|personal data|data breach|lawyer|legal notice|subpoena)\b/i },
  { category: 'repeated_failure', pattern: /\b(still (?:not working|broken)|already tried|third time|keeps failing|nothing has worked|contacted (?:you|support) before)\b/i },
]

export function classifyEscalation(transcript: string): EscalationCategory | null {
  const bounded = transcript.trim().slice(0, 1_200)
  return ESCALATION_RULES.find(({ pattern }) => pattern.test(bounded))?.category ?? null
}

export function escalationCategoryLabel(category: EscalationCategory): string {
  return CATEGORY_LABELS[category]
}
