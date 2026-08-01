import type { Env } from '../env'
import type { Communications, ConversationContentReference } from '../communications'
import { z } from 'zod'

const TEXT_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'text/plain; charset=utf-8',
  'x-content-type-options': 'nosniff',
}

const encoder = new TextEncoder()

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const webhookEnvelope = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({
    id: z.string().min(1),
    changes: z.array(z.object({
      field: z.literal('messages'),
      value: z.object({
        messaging_product: z.literal('whatsapp'),
        metadata: z.object({ phone_number_id: z.string().min(1) }),
        contacts: z.array(z.object({
          wa_id: z.string().min(1),
          profile: z.object({ name: z.string().min(1) }),
        })).optional(),
        messages: z.array(z.object({
          from: z.string().min(1),
          id: z.string().min(1),
          timestamp: z.string().regex(/^\d+$/),
          type: z.string().min(1),
          text: z.object({ body: z.string().min(1) }).optional(),
        }).passthrough()).optional(),
        statuses: z.array(z.object({
          id: z.string().min(1),
          status: z.enum(['sent', 'delivered', 'read', 'failed']),
          timestamp: z.string().regex(/^\d+$/),
        }).passthrough()).optional(),
      }).passthrough(),
    })),
  })),
})

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function optionalText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maximum) : null
}

function nonTextContentReference(message: { type: string } & Record<string, unknown>): ConversationContentReference {
  const details = asRecord(message[message.type])
  return {
    type: message.type.slice(0, 80),
    providerMediaId: optionalText(details?.id, 998),
    mimeType: optionalText(details?.mime_type, 160),
    filename: optionalText(details?.filename, 512),
    caption: optionalText(details?.caption, 4_000),
  }
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16)
  }
  return bytes
}

export async function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | null, appSecret: string): Promise<boolean> {
  if (!signatureHeader?.startsWith('sha256=')) return false
  const signature = hexBytes(signatureHeader.slice('sha256='.length))
  if (!signature) return false
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify('HMAC', key, signature.buffer as ArrayBuffer, encoder.encode(rawBody))
}

export function verifyWhatsAppWebhook(request: Request, env: Env): Response {
  if (!env.WHATSAPP_VERIFY_TOKEN) {
    return new Response('WhatsApp webhook is not configured', { status: 503, headers: TEXT_HEADERS })
  }

  const url = new URL(request.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')
  if (mode !== 'subscribe' || token !== env.WHATSAPP_VERIFY_TOKEN || !challenge) {
    return new Response('Forbidden', { status: 403, headers: TEXT_HEADERS })
  }

  return new Response(challenge, { status: 200, headers: TEXT_HEADERS })
}

export async function acceptWhatsAppWebhook(request: Request, env: Env, communications: Communications): Promise<Response> {
  if (!env.WHATSAPP_APP_SECRET || !env.WHATSAPP_WABA_ID || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return new Response('WhatsApp webhook is not configured', { status: 503, headers: TEXT_HEADERS })
  }
  const rawBody = await request.text()
  const valid = await verifyWhatsAppSignature(rawBody, request.headers.get('x-hub-signature-256'), env.WHATSAPP_APP_SECRET)
  if (!valid) return new Response('Invalid signature', { status: 401, headers: TEXT_HEADERS })

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return new Response('Invalid webhook payload', { status: 400, headers: TEXT_HEADERS })
  }
  const envelope = webhookEnvelope.safeParse(parsed)
  if (!envelope.success) return new Response('Invalid webhook payload', { status: 400, headers: TEXT_HEADERS })
  const webhookPayloadHash = await sha256(rawBody)

  for (const entry of envelope.data.entry) {
    if (entry.id !== env.WHATSAPP_WABA_ID) return new Response('Unexpected WhatsApp account', { status: 403, headers: TEXT_HEADERS })
    for (const change of entry.changes) {
      if (change.value.metadata.phone_number_id !== env.WHATSAPP_PHONE_NUMBER_ID) {
        return new Response('Unexpected WhatsApp phone number', { status: 403, headers: TEXT_HEADERS })
      }
      for (const message of change.value.messages ?? []) {
        const contact = change.value.contacts?.find((candidate) => candidate.wa_id === message.from)
        const occurredAt = new Date(Number(message.timestamp) * 1_000)
        if (Number.isNaN(occurredAt.valueOf())) return new Response('Invalid webhook payload', { status: 400, headers: TEXT_HEADERS })
        const phone = message.from.startsWith('+') ? message.from : `+${message.from}`
        const content = message.type === 'text' ? null : nonTextContentReference(message)
        await communications.ingest(
          {
            channel: 'whatsapp',
            provider: 'meta_whatsapp',
            providerEventId: message.id,
            providerMessageId: message.id,
            accountId: entry.id,
            endpointId: change.value.metadata.phone_number_id,
            externalThreadId: message.from,
            occurredAt: occurredAt.toISOString(),
            payloadHash: webhookPayloadHash,
          },
          {
            contact: {
              name: contact?.profile.name ?? `WhatsApp ${phone}`,
              address: { kind: 'phone', value: phone },
            },
            body: message.type === 'text' && message.text
              ? message.text.body
              : `WhatsApp ${message.type} message received. Its content is not available in this pilot.`,
            content,
          },
        )
      }
      for (const status of change.value.statuses ?? []) {
        const occurredAt = new Date(Number(status.timestamp) * 1_000)
        if (Number.isNaN(occurredAt.valueOf())) return new Response('Invalid webhook payload', { status: 400, headers: TEXT_HEADERS })
        await communications.observeDelivery({
          provider: 'meta_whatsapp',
          accountId: entry.id,
          providerMessageId: status.id,
          status: status.status,
          occurredAt: occurredAt.toISOString(),
          payloadHash: webhookPayloadHash,
        })
      }
    }
  }
  return new Response('EVENT_RECEIVED', { status: 200, headers: TEXT_HEADERS })
}
