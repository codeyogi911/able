/**
 * Shopify customer-account sign-in: an optional verified-identity rail for the
 * public support surfaces. A signed-in customer skips the contact card and may
 * ask about their own orders; anonymous visitors keep the progressive flow.
 *
 * Mechanics: the OAuth 2.0 authorization-code flow of the Customer Account API
 * with a public client and PKCE (S256). Endpoints are resolved through the
 * shop's discovery documents rather than hardcoded hosts, and the customer
 * data read is a bounded projection — profile plus recent orders — matching
 * the read-back standard of the possession-based order lookup. Provider
 * failures become typed 'unavailable' results; raw errors never reach the
 * model or the customer.
 *
 * The session and login transaction travel as HMAC-signed tokens in secure
 * transport cookies, signed with the deployment's customer-capability secret.
 * The access token inside the session belongs to the customer whose browser
 * carries the cookie; the signature only prevents forgery and tampering.
 */

const DISCOVERY_TTL_MS = 10 * 60_000
const DEFAULT_TIMEOUT_MS = 10_000
const OAUTH_SCOPE = 'openid email customer-account-api:full'
const ORDER_LIMIT = 5
const LINE_ITEM_LIMIT = 10
const TRACKING_LIMIT = 5

export const SHOPIFY_CUSTOMER_SESSION_COOKIE = 'able_shopify_customer'
export const SHOPIFY_CUSTOMER_LOGIN_COOKIE = 'able_shopify_login'
/** Login transactions are short-lived: the redirect round-trip only. */
export const SHOPIFY_LOGIN_TRANSACTION_TTL_SECONDS = 10 * 60
export const SHOPIFY_CUSTOMER_SESSION_MAX_SECONDS = 60 * 60

type ShopifyCustomerEnv = {
  SHOPIFY_SHOP_DOMAIN?: string
  SHOPIFY_CUSTOMER_CLIENT_ID?: string
}

export type ShopifyCustomerSession = {
  name: string
  email: string
  accessToken: string
  expiresAt: number
}

export type ShopifyCustomerOrder = {
  name: string
  processedAt: string
  financialStatus: string | null
  fulfillmentStatus: string | null
  total: { amount: string; currencyCode: string } | null
  lineItems: { title: string; quantity: number }[]
  tracking: { number: string | null; url: string | null }[]
}

export type ShopifyCustomerContextResult =
  | { status: 'ok'; customer: { name: string; email: string | null; orders: ShopifyCustomerOrder[] } }
  | { status: 'unavailable' }

type LoginTransaction = { state: string; verifier: string; expiresAt: number }

type Discovery = { authorizationEndpoint: string; tokenEndpoint: string; graphqlEndpoint: string }

const encoder = new TextEncoder()

function shopHostname(domain: string | undefined): string | null {
  const trimmed = (domain ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  return /^[a-z0-9][a-z0-9.-]+$/i.test(trimmed) ? trimmed.toLowerCase() : null
}

export function shopifyCustomerConfigured(env: ShopifyCustomerEnv): boolean {
  return Boolean(shopHostname(env.SHOPIFY_SHOP_DOMAIN) && env.SHOPIFY_CUSTOMER_CLIENT_ID?.trim())
}

function logOutcome(outcome: string, detail: Record<string, unknown> = {}): void {
  // Booleans and HTTP statuses only: no tokens, emails, or customer data.
  console.warn(JSON.stringify({ event: 'shopify_customer_identity', outcome, ...detail }))
}

let cachedDiscovery: { hostname: string; discovery: Discovery; expiresAt: number } | null = null

export function resetShopifyCustomerDiscoveryCache(): void {
  cachedDiscovery = null
}

async function fetchJson(fetcher: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<unknown | null> {
  try {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
      logOutcome('http_error', { url: new URL(url).pathname, status: response.status })
      return null
    }
    return await response.json()
  } catch {
    logOutcome('network_error', { url: new URL(url).pathname })
    return null
  }
}

async function discover(hostname: string, fetcher: typeof fetch, now: number, timeoutMs: number): Promise<Discovery | null> {
  if (cachedDiscovery && cachedDiscovery.hostname === hostname && cachedDiscovery.expiresAt > now) {
    return cachedDiscovery.discovery
  }
  const [openid, api] = await Promise.all([
    fetchJson(fetcher, `https://${hostname}/.well-known/openid-configuration`, {}, timeoutMs),
    fetchJson(fetcher, `https://${hostname}/.well-known/customer-account-api`, {}, timeoutMs),
  ])
  const authorizationEndpoint = (openid as Record<string, unknown>)?.['authorization_endpoint']
  const tokenEndpoint = (openid as Record<string, unknown>)?.['token_endpoint']
  const apiRecord = api as Record<string, unknown> | null
  const graphqlEndpoint = apiRecord?.['graphql_api'] ?? apiRecord?.['graphql_endpoint'] ?? apiRecord?.['graphqlApi']
  if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string' || typeof graphqlEndpoint !== 'string') {
    logOutcome('discovery_incomplete', {
      hasAuthorization: typeof authorizationEndpoint === 'string',
      hasToken: typeof tokenEndpoint === 'string',
      hasGraphql: typeof graphqlEndpoint === 'string',
    })
    return null
  }
  const discovery = { authorizationEndpoint, tokenEndpoint, graphqlEndpoint }
  cachedDiscovery = { hostname, discovery, expiresAt: now + DISCOVERY_TTL_MS }
  return discovery
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`able:shopify-customer:v1:${payload}`))))
}

async function signToken(secret: string, value: unknown): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify(value)))
  return `v1.${payload}.${await hmac(secret, payload)}`
}

async function verifyToken(secret: string, token: string): Promise<unknown | null> {
  const [version, payload, signature] = token.split('.')
  if (version !== 'v1' || !payload || !signature) return null
  const expected = await hmac(secret, payload)
  const a = encoder.encode(signature)
  const b = encoder.encode(expected)
  if (a.byteLength !== b.byteLength) return null
  let mismatch = 0
  for (let index = 0; index < a.byteLength; index++) mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0)
  if (mismatch !== 0) return null
  const decoded = base64UrlDecode(payload)
  if (!decoded) return null
  try {
    return JSON.parse(new TextDecoder().decode(decoded))
  } catch {
    return null
  }
}

export type ShopifyLoginStart = { url: string; transactionToken: string }

/**
 * Build the authorization redirect and the signed single-use transaction that
 * the callback must present. The caller stores the transaction token in a
 * short-lived cookie for the redirect round-trip.
 */
export async function beginShopifyCustomerLogin(
  env: ShopifyCustomerEnv,
  input: { redirectUri: string; secret: string },
  options: { fetcher?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
): Promise<ShopifyLoginStart | null> {
  const hostname = shopHostname(env.SHOPIFY_SHOP_DOMAIN)
  const clientId = env.SHOPIFY_CUSTOMER_CLIENT_ID?.trim()
  if (!hostname || !clientId || !input.secret) return null
  const now = options.now?.() ?? Date.now()
  const discovery = await discover(hostname, options.fetcher ?? fetch, now, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  if (!discovery) return null

  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)))
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))))

  const url = new URL(discovery.authorizationEndpoint)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', OAUTH_SCOPE)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')

  const transaction: LoginTransaction = { state, verifier, expiresAt: now + SHOPIFY_LOGIN_TRANSACTION_TTL_SECONDS * 1000 }
  return { url: url.toString(), transactionToken: await signToken(input.secret, transaction) }
}

/**
 * Exchange the callback code for a customer session. The state must match the
 * signed transaction issued by beginShopifyCustomerLogin, and the customer
 * profile is read immediately so the session carries a verified name and
 * email without storing anything server-side.
 */
export async function completeShopifyCustomerLogin(
  env: ShopifyCustomerEnv,
  input: { code: string; state: string; transactionToken: string; redirectUri: string; secret: string },
  options: { fetcher?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
): Promise<{ session: ShopifyCustomerSession; sessionToken: string } | null> {
  const hostname = shopHostname(env.SHOPIFY_SHOP_DOMAIN)
  const clientId = env.SHOPIFY_CUSTOMER_CLIENT_ID?.trim()
  if (!hostname || !clientId || !input.secret || !input.code || !input.state) return null
  const now = options.now?.() ?? Date.now()

  const transaction = await verifyToken(input.secret, input.transactionToken) as LoginTransaction | null
  if (!transaction || transaction.state !== input.state || transaction.expiresAt < now) {
    logOutcome('transaction_rejected', { present: transaction !== null })
    return null
  }

  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const discovery = await discover(hostname, fetcher, now, timeoutMs)
  if (!discovery) return null

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: transaction.verifier,
  })
  const grant = await fetchJson(fetcher, discovery.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, timeoutMs) as Record<string, unknown> | null
  const accessToken = grant?.['access_token']
  const expiresIn = grant?.['expires_in']
  if (typeof accessToken !== 'string' || !accessToken) {
    logOutcome('token_exchange_failed')
    return null
  }

  const context = await shopifyCustomerContext(env, accessToken, { orders: 0, fetcher, timeoutMs })
  if (context.status !== 'ok') return null

  const lifetimeSeconds = Math.min(
    typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : SHOPIFY_CUSTOMER_SESSION_MAX_SECONDS,
    SHOPIFY_CUSTOMER_SESSION_MAX_SECONDS,
  )
  const session: ShopifyCustomerSession = {
    name: context.customer.name,
    email: context.customer.email ?? '',
    accessToken,
    expiresAt: now + lifetimeSeconds * 1000,
  }
  if (!session.email) {
    // The support flows key customers by email; a session without one cannot
    // participate in the verified rail.
    logOutcome('missing_email')
    return null
  }
  return { session, sessionToken: await signToken(input.secret, session) }
}

/** Sign a customer session into the transportable cookie token form. */
export function signShopifyCustomerSession(secret: string, session: ShopifyCustomerSession): Promise<string> {
  return signToken(secret, session)
}

export async function verifyShopifyCustomerSession(
  secret: string,
  token: string | null | undefined,
  now: number = Date.now(),
): Promise<ShopifyCustomerSession | null> {
  if (!secret || !token) return null
  const parsed = await verifyToken(secret, token) as ShopifyCustomerSession | null
  if (!parsed || typeof parsed.email !== 'string' || typeof parsed.accessToken !== 'string') return null
  if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt < now) return null
  return {
    name: typeof parsed.name === 'string' ? parsed.name : '',
    email: parsed.email,
    accessToken: parsed.accessToken,
    expiresAt: parsed.expiresAt,
  }
}

// Validated against the Customer Account API 2026-07 schema.
const CUSTOMER_CONTEXT_QUERY = `query AbleCustomerContext($first: Int!) {
  customer {
    displayName
    emailAddress { emailAddress }
    orders(first: $first, sortKey: PROCESSED_AT, reverse: true) {
      nodes {
        name
        processedAt
        financialStatus
        fulfillmentStatus
        totalPrice { amount currencyCode }
        lineItems(first: ${LINE_ITEM_LIMIT}) { nodes { name quantity } }
        fulfillments(first: ${TRACKING_LIMIT}) { nodes { trackingInformation { number url } } }
      }
    }
  }
}`

/**
 * Bounded read of the signed-in customer's profile and most recent orders.
 * `orders: 0` skips the order projection for a profile-only read.
 */
export async function shopifyCustomerContext(
  env: ShopifyCustomerEnv,
  accessToken: string,
  options: { orders?: number; fetcher?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
): Promise<ShopifyCustomerContextResult> {
  const hostname = shopHostname(env.SHOPIFY_SHOP_DOMAIN)
  if (!hostname || !accessToken) return { status: 'unavailable' }
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const discovery = await discover(hostname, fetcher, options.now?.() ?? Date.now(), timeoutMs)
  if (!discovery) return { status: 'unavailable' }

  const first = Math.max(0, Math.min(options.orders ?? ORDER_LIMIT, ORDER_LIMIT))
  const result = await fetchJson(fetcher, discovery.graphqlEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: accessToken },
    body: JSON.stringify({ query: CUSTOMER_CONTEXT_QUERY, variables: { first: Math.max(first, 1) } }),
  }, timeoutMs) as Record<string, unknown> | null
  const data = (result?.['data'] as Record<string, unknown> | undefined)?.['customer'] as Record<string, unknown> | undefined
  if (!data) {
    logOutcome('context_unavailable', { hasErrors: Array.isArray(result?.['errors']) })
    return { status: 'unavailable' }
  }

  const email = ((data['emailAddress'] as Record<string, unknown> | null)?.['emailAddress'] ?? null) as string | null
  const rawOrders = ((data['orders'] as Record<string, unknown> | null)?.['nodes'] ?? []) as Record<string, unknown>[]
  const orders: ShopifyCustomerOrder[] = (first === 0 ? [] : rawOrders).slice(0, ORDER_LIMIT).map((order) => ({
    name: String(order['name'] ?? ''),
    processedAt: String(order['processedAt'] ?? ''),
    financialStatus: typeof order['financialStatus'] === 'string' ? order['financialStatus'] : null,
    fulfillmentStatus: typeof order['fulfillmentStatus'] === 'string' ? order['fulfillmentStatus'] : null,
    total: ((): { amount: string; currencyCode: string } | null => {
      const total = order['totalPrice'] as Record<string, unknown> | null
      return total && typeof total['amount'] === 'string' && typeof total['currencyCode'] === 'string'
        ? { amount: total['amount'], currencyCode: total['currencyCode'] }
        : null
    })(),
    lineItems: (((order['lineItems'] as Record<string, unknown> | null)?.['nodes'] ?? []) as Record<string, unknown>[])
      .slice(0, LINE_ITEM_LIMIT)
      .map((item) => ({ title: String(item['name'] ?? ''), quantity: Number(item['quantity'] ?? 0) })),
    tracking: (((order['fulfillments'] as Record<string, unknown> | null)?.['nodes'] ?? []) as Record<string, unknown>[])
      .flatMap((fulfillment) => {
        const tracking = fulfillment['trackingInformation']
        if (Array.isArray(tracking)) return tracking as Record<string, unknown>[]
        return tracking && typeof tracking === 'object' ? [tracking as Record<string, unknown>] : []
      })
      .slice(0, TRACKING_LIMIT)
      .map((entry) => ({
        number: typeof entry['number'] === 'string' ? entry['number'] : null,
        url: typeof entry['url'] === 'string' ? entry['url'] : null,
      })),
  }))
  return {
    status: 'ok',
    customer: { name: String(data['displayName'] ?? '').trim() || 'Store customer', email, orders },
  }
}
