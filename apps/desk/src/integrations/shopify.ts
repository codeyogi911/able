/**
 * Minimal Shopify Admin GraphQL adapter for voice-session order read-back.
 * Authorization is possession of the (order number, contact email) pair — the
 * same standard as Shopify's own order-status page. Bounded projection only:
 * no addresses, no payment details beyond the order total. Any provider
 * failure becomes a typed 'unavailable' result — raw Shopify errors never
 * reach the model.
 *
 * Auth: the current Shopify server-side flow is the OAuth client credentials
 * grant (POST https://{shop}/admin/oauth/access_token with client_id,
 * client_secret, grant_type=client_credentials → { access_token, expires_in }).
 * Tokens are cached in module memory and refreshed on expiry. A legacy
 * custom-app Admin token (SHOPIFY_ADMIN_TOKEN) is still honored and bypasses
 * the token endpoint entirely.
 */

export const SHOPIFY_API_VERSION = '2025-10'

const LINE_ITEM_LIMIT = 10
const TRACKING_LIMIT = 5
const DEFAULT_TIMEOUT_MS = 10_000
const TOKEN_SAFETY_MARGIN_MS = 5 * 60_000

type ShopifyEnv = {
  SHOPIFY_SHOP_DOMAIN?: string
  SHOPIFY_ADMIN_TOKEN?: string
  SHOPIFY_CLIENT_ID?: string
  SHOPIFY_CLIENT_SECRET?: string
}

export type ShopifyOrderSummary = {
  name: string
  createdAt: string
  financialStatus: string | null
  fulfillmentStatus: string | null
  total: { amount: string; currencyCode: string } | null
  lineItems: { title: string; quantity: number }[]
  tracking: { number: string | null; url: string | null }[]
}

export type ShopifyOrderResult =
  | { status: 'ok'; order: ShopifyOrderSummary }
  | { status: 'not_found' }
  | { status: 'unavailable' }

type LookupOptions = {
  fetcher?: typeof fetch
  timeoutMs?: number
  now?: () => number
}

// The order's email field is requested ONLY for the server-side pair check
// below; it is never part of the returned projection.
const ORDER_QUERY = `query VoiceOrder($query: String!) {
  orders(first: 1, query: $query) {
    nodes {
      name
      email
      createdAt
      displayFinancialStatus
      displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: ${LINE_ITEM_LIMIT}) { nodes { title quantity } }
      fulfillments(first: ${TRACKING_LIMIT}) { trackingInfo(first: ${TRACKING_LIMIT}) { number url } }
    }
  }
}`

let cachedGrant: { hostname: string; clientId: string; token: string; expiresAt: number } | null = null

/** Test seam: clears the module-level client-credentials token cache. */
export function resetShopifyTokenCache(): void {
  cachedGrant = null
}

function shopHostname(domain: string | undefined): string | null {
  const trimmed = (domain ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  return /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(trimmed) ? trimmed.toLowerCase() : null
}

function clientCredentials(env: ShopifyEnv): { clientId: string; clientSecret: string } | null {
  const clientId = env.SHOPIFY_CLIENT_ID?.trim()
  const clientSecret = env.SHOPIFY_CLIENT_SECRET?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

export function shopifyConfigured(env: ShopifyEnv): boolean {
  if (shopHostname(env.SHOPIFY_SHOP_DOMAIN) === null) return false
  return Boolean(env.SHOPIFY_ADMIN_TOKEN?.trim()) || clientCredentials(env) !== null
}

async function fetchGrantToken(
  hostname: string,
  credentials: { clientId: string; clientSecret: string },
  fetcher: typeof fetch,
  timeoutMs: number,
  now: () => number,
): Promise<string | null> {
  try {
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: 'client_credentials',
    })
    const response = await fetcher(`https://${hostname}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const payload = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null
    const token = typeof payload?.access_token === 'string' && payload.access_token ? payload.access_token : null
    if (!token) return null
    const lifetimeMs = (typeof payload?.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 86_399) * 1_000
    cachedGrant = {
      hostname,
      clientId: credentials.clientId,
      token,
      expiresAt: now() + Math.max(lifetimeMs - TOKEN_SAFETY_MARGIN_MS, 60_000),
    }
    return token
  } catch {
    return null
  }
}

async function grantToken(
  hostname: string,
  credentials: { clientId: string; clientSecret: string },
  fetcher: typeof fetch,
  timeoutMs: number,
  now: () => number,
): Promise<string | null> {
  if (
    cachedGrant
    && cachedGrant.hostname === hostname
    && cachedGrant.clientId === credentials.clientId
    && cachedGrant.expiresAt > now()
  ) {
    return cachedGrant.token
  }
  cachedGrant = null
  return fetchGrantToken(hostname, credentials, fetcher, timeoutMs, now)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null
}

function orderSummary(node: unknown): ShopifyOrderSummary | null {
  if (!node || typeof node !== 'object') return null
  const order = node as Record<string, unknown>
  const name = text(order.name)
  const createdAt = text(order.createdAt)
  if (!name || !createdAt) return null

  const money = (order.currentTotalPriceSet as { shopMoney?: { amount?: unknown; currencyCode?: unknown } } | null | undefined)?.shopMoney
  const amount = text(money?.amount)
  const currencyCode = text(money?.currencyCode)

  const lineItemNodes = (order.lineItems as { nodes?: unknown[] } | null | undefined)?.nodes ?? []
  const lineItems = (Array.isArray(lineItemNodes) ? lineItemNodes : []).slice(0, LINE_ITEM_LIMIT).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const { title, quantity } = item as Record<string, unknown>
    const cleanTitle = text(title)
    return cleanTitle ? [{ title: cleanTitle, quantity: typeof quantity === 'number' ? quantity : 1 }] : []
  })

  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : []
  const tracking = fulfillments.slice(0, TRACKING_LIMIT).flatMap((fulfillment) => {
    const info = (fulfillment as { trackingInfo?: unknown[] } | null | undefined)?.trackingInfo ?? []
    return (Array.isArray(info) ? info : []).slice(0, TRACKING_LIMIT).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const { number, url } = entry as Record<string, unknown>
      return [{ number: text(number), url: text(url) }]
    })
  }).filter((entry) => entry.number !== null || entry.url !== null)

  return {
    name,
    createdAt,
    financialStatus: text(order.displayFinancialStatus),
    fulfillmentStatus: text(order.displayFulfillmentStatus),
    total: amount && currencyCode ? { amount, currencyCode } : null,
    lineItems,
    tracking,
  }
}

/**
 * Accepts "#1234", "1234", surrounding/inner whitespace, and lowercase
 * store-prefixed names ("en1001"). Returns the candidate order names to query:
 * the normalized value with and without the "#" prefix (stores can also
 * configure their own prefix/suffix, which the caller's value must include).
 */
function orderNameCandidates(orderNumber: string): string[] {
  const compact = orderNumber.replace(/\s+/g, '').toUpperCase()
  const bare = compact.replace(/^#/, '')
  if (!bare || bare.length > 32) return []
  return [...new Set([`#${bare}`, bare])]
}

const NOT_FOUND: ShopifyOrderResult = { status: 'not_found' }

// Operator-facing outcome telemetry. Must never include emails, order
// numbers, or tokens — booleans and HTTP status codes only.
function logLookupOutcome(outcome: string, detail: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ event: 'shopify_order_lookup', outcome, ...detail }))
}

export async function lookupOrderByNumber(
  env: ShopifyEnv,
  orderNumber: string,
  email: string,
  options: LookupOptions = {},
): Promise<ShopifyOrderResult> {
  const hostname = shopHostname(env.SHOPIFY_SHOP_DOMAIN)
  const adminToken = env.SHOPIFY_ADMIN_TOKEN?.trim() || null
  const credentials = clientCredentials(env)
  const normalizedEmail = email.trim().toLowerCase()
  if (!hostname || (!adminToken && !credentials) || !normalizedEmail) {
    logLookupOutcome('unconfigured', {
      hasHostname: hostname !== null,
      hasCredentials: Boolean(adminToken || credentials),
      hasEmail: Boolean(normalizedEmail),
    })
    return { status: 'unavailable' }
  }
  const candidates = orderNameCandidates(orderNumber)
  if (candidates.length === 0) {
    logLookupOutcome('invalid_number')
    return NOT_FOUND
  }

  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now

  const runQuery = async (token: string): Promise<Response> => fetcher(
    `https://${hostname}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopify-access-token': token,
      },
      body: JSON.stringify({
        query: ORDER_QUERY,
        variables: { query: candidates.map((candidate) => `name:${JSON.stringify(candidate)}`).join(' OR ') },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  )

  try {
    const token = adminToken ?? await grantToken(hostname, credentials!, fetcher, timeoutMs, now)
    if (!token) {
      logLookupOutcome('token_failed')
      return { status: 'unavailable' }
    }

    let response = await runQuery(token)
    if ((response.status === 401 || response.status === 403) && !adminToken) {
      // The cached grant may have been revoked or invalidated server-side:
      // drop the cache, re-authenticate once, and retry the query once.
      cachedGrant = null
      const freshToken = await fetchGrantToken(hostname, credentials!, fetcher, timeoutMs, now)
      if (!freshToken) {
        logLookupOutcome('token_failed', { afterHttpStatus: response.status })
        return { status: 'unavailable' }
      }
      response = await runQuery(freshToken)
    }
    if (!response.ok) {
      logLookupOutcome('http_error', { httpStatus: response.status })
      return { status: 'unavailable' }
    }

    const payload = await response.json().catch(() => null) as {
      data?: { orders?: { nodes?: unknown[] } }
      errors?: unknown[]
    } | null
    if (!payload || (Array.isArray(payload.errors) && payload.errors.length > 0)) {
      const firstError = Array.isArray(payload?.errors) ? payload?.errors[0] : null
      const code = (firstError as { extensions?: { code?: unknown } } | null)?.extensions?.code
      logLookupOutcome('graphql_errors', { code: typeof code === 'string' ? code : null })
      return { status: 'unavailable' }
    }
    const nodes = payload.data?.orders?.nodes
    if (!Array.isArray(nodes)) {
      logLookupOutcome('malformed')
      return { status: 'unavailable' }
    }

    // Authorization = the (order number, contact email) pair. An email
    // mismatch and a nonexistent order MUST be indistinguishable so that the
    // result never oracles which order numbers exist.
    const node = nodes[0]
    if (!node || typeof node !== 'object') {
      logLookupOutcome('no_match')
      return NOT_FOUND
    }
    const orderEmail = (node as { email?: unknown }).email
    if (typeof orderEmail !== 'string' || orderEmail.trim().toLowerCase() !== normalizedEmail) {
      logLookupOutcome('email_mismatch', { orderEmailMissing: typeof orderEmail !== 'string' || !orderEmail.trim() })
      return NOT_FOUND
    }
    const summary = orderSummary(node)
    if (!summary) {
      logLookupOutcome('summary_rejected')
      return NOT_FOUND
    }
    logLookupOutcome('ok')
    return { status: 'ok', order: summary }
  } catch (error) {
    logLookupOutcome('exception', { name: error instanceof Error ? error.name : null })
    return { status: 'unavailable' }
  }
}
