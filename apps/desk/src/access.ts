import type { Actor, OperatorRole } from './domain/types'
import type { Env } from './env'

type AccessErrorCode =
  | 'access_not_configured'
  | 'missing_access_token'
  | 'invalid_access_token'
  | 'operator_disabled'

type AccessJwk = JsonWebKey & {
  kid: string
  kty: 'RSA'
  n: string
  e: string
  alg?: string
  use?: string
}

type AccessClaims = {
  iss: string
  aud: string | string[]
  email: string
  name?: string
  exp: number
  nbf?: number
}

type OperatorRow = {
  id: string
  email: string
  name: string
  role: OperatorRole
  active: number
}

export type AccessVerificationOptions = {
  fetcher?: typeof fetch
  now?: () => number
}

export class AccessError extends Error {
  readonly name = 'AccessError'

  constructor(
    readonly code: AccessErrorCode,
    readonly status: 401 | 403 | 503,
    message: string,
  ) {
    super(message)
  }
}

const JWKS_TTL_MS = 60 * 60 * 1_000
const CLOCK_TOLERANCE_SECONDS = 60
const MAX_JWT_BYTES = 64 * 1_024
const issuerKeyCache = new Map<string, { fetchedAt: number; keys: AccessJwk[] }>()

function normalizeEmail(value: string | undefined): string {
  const email = value?.trim().toLowerCase() ?? ''
  if (
    email.length < 3 ||
    email.length > 320 ||
    email.includes('\0') ||
    /[\s\r\n]/.test(email) ||
    email.indexOf('@') <= 0 ||
    email.indexOf('@') !== email.lastIndexOf('@') ||
    email.endsWith('@')
  ) {
    return ''
  }
  return email
}

function displayName(value: unknown, email: string): string {
  const fromClaim = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : ''
  return (fromClaim || email.slice(0, email.indexOf('@')) || 'Operator').slice(0, 120)
}

function configuredIssuer(value: string | undefined): string | null {
  const configured = value?.trim()
  if (!configured) return null

  try {
    const url = new URL(configured.includes('://') ? configured : `https://${configured}`)
    const hostname = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      (url.pathname !== '' && url.pathname !== '/') ||
      !hostname.endsWith('.cloudflareaccess.com') ||
      hostname === 'cloudflareaccess.com'
    ) {
      return null
    }
    return `https://${hostname}`
  } catch {
    return null
  }
}

function isDevelopmentRequest(request: Request, env: Env): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || Array.isArray(env.TEST_MIGRATIONS)
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

function decodeJson(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAccessJwk(value: unknown): value is AccessJwk {
  return (
    isObject(value) &&
    value.kty === 'RSA' &&
    typeof value.kid === 'string' &&
    value.kid.length > 0 &&
    typeof value.n === 'string' &&
    value.n.length > 0 &&
    typeof value.e === 'string' &&
    value.e.length > 0 &&
    (value.alg === undefined || value.alg === 'RS256') &&
    (value.use === undefined || value.use === 'sig')
  )
}

async function fetchJwks(
  issuer: string,
  fetcher: typeof fetch,
  nowMilliseconds: number,
  bypassCache = false,
): Promise<AccessJwk[]> {
  const useSharedCache = fetcher === globalThis.fetch
  const cached = useSharedCache ? issuerKeyCache.get(issuer) : undefined
  if (!bypassCache && cached && nowMilliseconds - cached.fetchedAt < JWKS_TTL_MS) return cached.keys

  const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Access signing keys returned HTTP ${response.status}`)

  const document: unknown = await response.json()
  if (!isObject(document) || !Array.isArray(document.keys)) throw new Error('Access signing keys were malformed')
  const keys = document.keys.filter(isAccessJwk)
  if (keys.length === 0) throw new Error('Access signing keys did not contain an RS256 key')
  if (useSharedCache) issuerKeyCache.set(issuer, { fetchedAt: nowMilliseconds, keys })
  return keys
}

function parseClaims(value: unknown): AccessClaims | null {
  if (!isObject(value)) return null
  if (typeof value.iss !== 'string' || typeof value.email !== 'string' || typeof value.exp !== 'number') return null
  if (
    typeof value.aud !== 'string' &&
    !(Array.isArray(value.aud) && value.aud.every((audience) => typeof audience === 'string'))
  ) {
    return null
  }
  if (value.name !== undefined && typeof value.name !== 'string') return null
  if (value.nbf !== undefined && typeof value.nbf !== 'number') return null
  if (!Number.isFinite(value.exp) || (value.nbf !== undefined && !Number.isFinite(value.nbf))) return null
  return value as AccessClaims
}

async function verifyAccessAssertion(
  token: string,
  issuer: string,
  audience: string,
  options: Required<AccessVerificationOptions>,
): Promise<{ email: string; name: string } | null> {
  if (token.length === 0 || token.length > MAX_JWT_BYTES) return null
  const segments = token.split('.')
  if (segments.length !== 3) return null
  const [encodedHeader, encodedPayload, encodedSignature] = segments
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null

  let header: Record<string, unknown>
  let claims: AccessClaims | null
  try {
    const decodedHeader = decodeJson(encodedHeader)
    header = isObject(decodedHeader) ? decodedHeader : {}
    claims = parseClaims(decodeJson(encodedPayload))
  } catch {
    return null
  }

  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0 || !claims) return null
  if (header.typ !== undefined && header.typ !== 'JWT') return null
  if (claims.iss !== issuer) return null

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(audience)) return null

  const nowSeconds = Math.floor(options.now() / 1_000)
  if (nowSeconds > claims.exp + CLOCK_TOLERANCE_SECONDS) return null
  if (claims.nbf !== undefined && nowSeconds + CLOCK_TOLERANCE_SECONDS < claims.nbf) return null

  const email = normalizeEmail(claims.email)
  if (!email) return null

  let keys: AccessJwk[]
  try {
    keys = await fetchJwks(issuer, options.fetcher, options.now())
    if (!keys.some((candidate) => candidate.kid === header.kid) && options.fetcher === globalThis.fetch) {
      keys = await fetchJwks(issuer, options.fetcher, options.now(), true)
    }
  } catch {
    return null
  }

  const jwk = keys.find((candidate) => candidate.kid === header.kid)
  if (!jwk) return null

  try {
    const verificationKey = await crypto.subtle.importKey(
      'jwk',
      { ...jwk, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const signedContent = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    const verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      verificationKey,
      decodeBase64Url(encodedSignature) as BufferSource,
      signedContent,
    )
    if (!verified) return null
  } catch {
    return null
  }

  return { email, name: displayName(claims.name, email) }
}

async function provisionOperator(db: D1Database, email: string, name: string, ownerEmail: string): Promise<Actor> {
  const owner = ownerEmail !== '' && email === ownerEmail
  const role: OperatorRole = owner ? 'admin' : 'agent'
  const id = crypto.randomUUID()

  await db
    .prepare(
      `INSERT INTO operators (id, email, name, role)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO NOTHING`,
    )
    .bind(id, email, name, role)
    .run()

  if (owner) {
    await db.prepare("UPDATE operators SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE email = ? AND active = 1").bind(email).run()
  }

  const operator = await db
    .prepare('SELECT id, email, name, role, active FROM operators WHERE email = ?')
    .bind(email)
    .first<OperatorRow>()
  if (!operator || operator.active !== 1) {
    throw new AccessError('operator_disabled', 403, 'This operator is not active')
  }

  return {
    id: operator.id,
    email: operator.email.toLowerCase(),
    name: operator.name,
    role: operator.role,
  }
}

/**
 * Authenticate the identity already approved by Cloudflare Access and turn it
 * into the only Actor object adapters may pass into the Helpdesk module.
 *
 * Access Managed OAuth presents an opaque token to the edge. Cloudflare then
 * adds a signed `Cf-Access-Jwt-Assertion` for this Worker to verify. Tool input
 * is deliberately not involved in actor construction.
 */
export async function authenticateAccess(
  request: Request,
  env: Env,
  verification: AccessVerificationOptions = {},
): Promise<Actor> {
  const ownerEmail = normalizeEmail(env.MORROW_OWNER_EMAIL)
  const developmentEmail = normalizeEmail(env.MORROW_DEV_EMAIL)
  if (developmentEmail && isDevelopmentRequest(request, env)) {
    return provisionOperator(env.DB, developmentEmail, displayName(undefined, developmentEmail), ownerEmail || developmentEmail)
  }

  const audience = env.CF_ACCESS_AUD?.trim() ?? ''
  const issuer = configuredIssuer(env.CF_ACCESS_TEAM_DOMAIN)
  if (!audience || !issuer) {
    throw new AccessError(
      'access_not_configured',
      503,
      'Cloudflare Access audience and team domain must be configured',
    )
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion')?.trim() ?? ''
  if (!token) throw new AccessError('missing_access_token', 401, 'Cloudflare Access assertion is required')

  const identity = await verifyAccessAssertion(token, issuer, audience, {
    fetcher: verification.fetcher ?? globalThis.fetch,
    now: verification.now ?? Date.now,
  })
  if (!identity) throw new AccessError('invalid_access_token', 403, 'Cloudflare Access assertion is invalid')
  return provisionOperator(env.DB, identity.email, identity.name, ownerEmail)
}

export function accessErrorResponse(error: unknown): Response {
  if (!(error instanceof AccessError)) return new Response('Internal Server Error', { status: 500 })
  return Response.json(
    { error: error.code },
    {
      status: error.status,
      headers: {
        'cache-control': 'no-store',
        vary: 'Cf-Access-Jwt-Assertion',
      },
    },
  )
}
