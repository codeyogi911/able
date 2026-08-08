import { z } from 'zod'

const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().max(254).email().transform((value) => value.toLowerCase()),
})

/**
 * The support contact for a session. Identity is Shopify-first: this is
 * derived from the verified store-account session, never typed into the chat.
 */
export type VoiceContact = z.output<typeof contactSchema>

export function normalizeVoiceContact(value: unknown): VoiceContact | null {
  const parsed = contactSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The support action a sign-in was requested for. */
export type VoiceSignInReason = 'order_lookup' | 'open_ticket'

/**
 * Resume the exact agent flow interrupted by the sign-in hand-off. The client
 * sends this as the first turn after returning from the hosted store login so
 * the pending action completes deterministically instead of the model having
 * to infer it.
 */
export const SIGN_IN_CONTINUATION =
  'I have signed in with my store account. Continue what I asked for before signing in.'
