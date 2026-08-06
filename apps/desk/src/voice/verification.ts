import type { VoiceContact } from './contact'

const CODE_TTL_MS = 10 * 60 * 1_000
const encoder = new TextEncoder()

export type VoiceVerificationChallenge = {
  contact: VoiceContact
  salt: string
  signature: string
  expiresAt: number
}

type VerificationDependencies = {
  now?: () => number
  code?: () => string
  salt?: () => string
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeBase64Url(value: string): ArrayBuffer {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer as ArrayBuffer
}

function secureToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(18)))
}

function secureCode(): string {
  const ceiling = 256 - (256 % 10)
  const digits: number[] = []
  while (digits.length < 6) {
    const bytes = crypto.getRandomValues(new Uint8Array(6 - digits.length))
    for (const byte of bytes) {
      if (byte < ceiling) digits.push(byte % 10)
      if (digits.length === 6) break
    }
  }
  return digits.join('')
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(`able.voice-verification.v1\0${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function signedValue(contact: VoiceContact, code: string, salt: string, expiresAt: number): string {
  return JSON.stringify(['voice-verification.v1', contact.email, code, salt, expiresAt])
}

/**
 * Creates an HMAC-protected email verification challenge. Only the signature
 * and salt — never the plaintext code — need to be retained in connection
 * state. Verifying the emailed code proves the caller controls the mailbox and
 * upgrades the session from unverified contact to verified read-back.
 */
export async function createVoiceVerification(
  contact: VoiceContact,
  secret: string,
  dependencies: VerificationDependencies = {},
): Promise<{ code: string; challenge: VoiceVerificationChallenge }> {
  const code = dependencies.code?.() ?? secureCode()
  if (!/^\d{6}$/.test(code)) throw new Error('Voice verification code generator must return six digits')
  const salt = dependencies.salt?.() ?? secureToken()
  const expiresAt = (dependencies.now?.() ?? Date.now()) + CODE_TTL_MS
  const signature = base64Url(new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(signedValue(contact, code, salt, expiresAt)),
  )))
  return { code, challenge: { contact, salt, signature, expiresAt } }
}

export async function verifyVoiceVerificationCode(
  challenge: VoiceVerificationChallenge,
  code: string,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (now > challenge.expiresAt || !/^\d{6}$/.test(code)) return false
  try {
    return await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      decodeBase64Url(challenge.signature),
      encoder.encode(signedValue(challenge.contact, code, challenge.salt, challenge.expiresAt)),
    )
  } catch {
    return false
  }
}
