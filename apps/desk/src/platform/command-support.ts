import type { Actor } from '../domain/types'

const encoder = new TextEncoder()

export function defaultUuid(): string {
  return crypto.randomUUID()
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function cleanText(value: string, label: string, maximum: number): string {
  const cleaned = value.replaceAll('\u0000', '').trim()
  if (!cleaned) throw new Error(`${label} is required`)
  if (cleaned.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer`)
  return cleaned
}

export function cleanIsoTimestamp(value: string, label: string): string {
  const cleaned = cleanText(value, label, 80)
  const date = new Date(cleaned)
  if (Number.isNaN(date.valueOf())) throw new Error(`${label} must be an ISO 8601 timestamp`)
  return date.toISOString()
}

export async function ensureOperator(db: D1Database, actor: Actor, now: () => Date): Promise<Actor> {
  const email = cleanText(actor.email, 'Operator email', 320).toLowerCase()
  const existing = await db.prepare(
    'SELECT id, email, name, role FROM operators WHERE email = ? COLLATE NOCASE',
  ).bind(email).first<Actor>()
  if (existing) return existing
  const id = cleanText(actor.id, 'Operator ID', 128)
  const name = cleanText(actor.name, 'Operator name', 160)
  const timestamp = now().toISOString()
  await db.prepare(
    'INSERT INTO operators (id, email, name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, email, name, actor.role, timestamp, timestamp).run()
  return { id, email, name, role: actor.role }
}
