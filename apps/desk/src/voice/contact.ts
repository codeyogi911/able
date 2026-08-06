import { z } from 'zod'

const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().max(254).email().transform((value) => value.toLowerCase()),
})

export type VoiceContact = z.output<typeof contactSchema>

/**
 * Normalizes the caller-supplied contact details. The name and email are
 * UNVERIFIED contact information — the same trust level as the portal's
 * public request form. They are collected only when a support action needs
 * durable identity; the email also scopes order lookups to this session.
 */
export function normalizeVoiceContact(value: unknown): VoiceContact | null {
  const parsed = contactSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function hasVoiceContact(state: unknown): state is { contact: VoiceContact } {
  if (!state || typeof state !== 'object') return false
  return normalizeVoiceContact((state as { contact?: unknown }).contact) !== null
}

export type VoiceContactContinuation =
  | 'continue'
  | 'open_ticket'
  | 'order_lookup'
  | 'product_help'
  | 'handled'

export const PRODUCT_HELP_CONTACT_CONTINUATION =
  'I have shared my name and email. Ask me for my order number before opening a ticket.'
export const ORDER_LOOKUP_CONTACT_CONTINUATION =
  'I have shared my name and email. Continue the order lookup using the order number I already gave you, or ask me for it if it is missing.'

/**
 * Resume the exact agent flow interrupted by the in-thread identity card. These
 * client-authored turns are intentionally explicit so the model does not have
 * to infer the pending action from a generic identity confirmation.
 */
export function contactContinuationMessage(value: unknown): string | null {
  switch (value as VoiceContactContinuation) {
    case 'handled':
      return null
    case 'open_ticket':
      return 'I have shared my name and email. Continue opening the support ticket I requested.'
    case 'order_lookup':
      return ORDER_LOOKUP_CONTACT_CONTINUATION
    case 'product_help':
      return PRODUCT_HELP_CONTACT_CONTINUATION
    default:
      return 'I have shared my name and email.'
  }
}
