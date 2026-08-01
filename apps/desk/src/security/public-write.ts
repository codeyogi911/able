import type { Env } from '../env'

type TurnstileResponse = {
  success: boolean
  'error-codes'?: string[]
  hostname?: string
  action?: string
}

function isLocal(request: Request): boolean {
  const hostname = new URL(request.url).hostname
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost')
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin')
  if (!origin) return true
  if (origin === 'null') {
    const fetchSite = request.headers.get('Sec-Fetch-Site')
    return fetchSite === 'same-origin' || fetchSite === 'none'
  }
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

export async function verifyTurnstileProof(
  input: {
    token: string | null | undefined
    action: 'intake' | 'reply' | 'recover' | 'voice_session' | 'voice_verify'
    ip: string
    hostname: string
    local?: boolean
  },
  env: Pick<Env, 'TURNSTILE_SECRET_KEY'>,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (input.local && !env.TURNSTILE_SECRET_KEY) return { ok: true }
  if (!env.TURNSTILE_SECRET_KEY) return { ok: false, reason: 'turnstile_not_configured' }
  if (!input.token?.trim()) return { ok: false, reason: 'turnstile_required' }

  const body = new FormData()
  body.set('secret', env.TURNSTILE_SECRET_KEY)
  body.set('response', input.token.trim())
  if (input.ip !== 'unknown') body.set('remoteip', input.ip)
  const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body })
  if (!response.ok) return { ok: false, reason: 'turnstile_unavailable' }
  let result: TurnstileResponse
  try {
    result = await response.json<TurnstileResponse>()
  } catch {
    return { ok: false, reason: 'turnstile_unavailable' }
  }
  if (!result.success) return { ok: false, reason: result['error-codes']?.[0] ?? 'turnstile_failed' }
  if (result.action !== input.action) return { ok: false, reason: 'turnstile_action_mismatch' }
  if (!result.hostname || normalizedHostname(result.hostname) !== normalizedHostname(input.hostname)) {
    return { ok: false, reason: 'turnstile_hostname_mismatch' }
  }
  return { ok: true }
}

export async function verifyPublicWrite(
  request: Request,
  env: Env,
  token: string | null | undefined,
  action: 'intake' | 'reply' | 'recover',
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!sameOrigin(request)) return { ok: false, reason: 'origin_mismatch' }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const rate = await env.PUBLIC_RATE_LIMIT.limit({ key: `${action}:${ip}` })
  if (!rate.success) return { ok: false, reason: 'rate_limited' }

  return verifyTurnstileProof({
    token,
    action,
    ip,
    hostname: new URL(request.url).hostname,
    local: isLocal(request),
  }, env, fetcher)
}
