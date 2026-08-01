import { z } from 'zod'

const acceptedMessage = z.object({
  messaging_product: z.literal('whatsapp'),
  messages: z.array(z.object({ id: z.string().min(1) })).min(1),
})

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly details: {
      httpStatus: number
      code: number | null
      subcode: number | null
      type: string | null
      traceId: string | null
    },
  ) {
    super(message)
    this.name = 'WhatsAppApiError'
  }

  evidence(): string {
    return JSON.stringify({ provider: 'meta_whatsapp', message: this.message, ...this.details })
  }
}

export type WhatsAppClientConfig = {
  accessToken: string
  phoneNumberId: string
}

export async function sendWhatsAppText(
  config: WhatsAppClientConfig,
  recipient: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ messageId: string }> {
  const response = await fetchImpl(`https://graph.facebook.com/v25.0/${encodeURIComponent(config.phoneNumberId)}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: { preview_url: false, body },
    }),
  })

  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const metaError = payload && typeof payload === 'object' && 'error' in payload
      && payload.error && typeof payload.error === 'object'
      ? payload.error as Record<string, unknown>
      : null
    const metaMessage = typeof metaError?.message === 'string'
      ? metaError.message.replace(/[\r\n\t]+/g, ' ').slice(0, 300)
      : `HTTP ${response.status}`
    throw new WhatsAppApiError(
      `Meta rejected the WhatsApp message: ${metaMessage}`,
      response.status === 429 || response.status >= 500,
      {
        httpStatus: response.status,
        code: typeof metaError?.code === 'number' ? metaError.code : null,
        subcode: typeof metaError?.error_subcode === 'number' ? metaError.error_subcode : null,
        type: typeof metaError?.type === 'string' ? metaError.type.slice(0, 120) : null,
        traceId: typeof metaError?.fbtrace_id === 'string' ? metaError.fbtrace_id.slice(0, 160) : null,
      },
    )
  }

  const accepted = acceptedMessage.safeParse(payload)
  if (!accepted.success) {
    throw new Error('Meta returned an unexpected success response; message acceptance is unknown')
  }
  return { messageId: accepted.data.messages[0]!.id }
}
