import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  lookupOrderByNumber,
  resetShopifyTokenCache,
  SHOPIFY_API_VERSION,
  shopifyConfigured,
} from '../src/integrations/shopify'
import {
  findOrderNumber,
  isOrderLookupRequest,
  orderStatusForSession,
  orderStatusReply,
} from '../src/voice/orders'

const ENV = { SHOPIFY_SHOP_DOMAIN: 'example-store.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'shpat-test-token' }
const CC_ENV = {
  SHOPIFY_SHOP_DOMAIN: 'example-store.myshopify.com',
  SHOPIFY_CLIENT_ID: 'client-id-1',
  SHOPIFY_CLIENT_SECRET: 'client-secret-1',
}
const TOKEN_ENDPOINT = 'https://example-store.myshopify.com/admin/oauth/access_token'
const GRAPHQL_ENDPOINT = `https://example-store.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`

const ORDER_NODE = {
  name: '#4021',
  email: 'ADA@example.test',
  createdAt: '2026-07-18T09:30:00Z',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'FULFILLED',
  currentTotalPriceSet: { shopMoney: { amount: '42.50', currencyCode: 'SGD' } },
  lineItems: { nodes: [{ title: 'Wi-Fi Router', quantity: 1 }] },
  fulfillments: [{ trackingInfo: [{ number: 'TRACK123', url: 'https://track.example.test/TRACK123' }] }],
}

const ORDER_SUMMARY = {
  name: '#4021',
  createdAt: '2026-07-18T09:30:00Z',
  financialStatus: 'PAID',
  fulfillmentStatus: 'FULFILLED',
  total: { amount: '42.50', currencyCode: 'SGD' },
  lineItems: [{ title: 'Wi-Fi Router', quantity: 1 }],
  tracking: [{ number: 'TRACK123', url: 'https://track.example.test/TRACK123' }],
}

function graphqlResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

function ordersPayload(nodes: unknown[]): unknown {
  return { data: { orders: { nodes } } }
}

describe('shopify adapter', () => {
  beforeEach(() => resetShopifyTokenCache())

  it('is configured only with a plausible shop hostname and working credentials', () => {
    expect(shopifyConfigured({})).toBe(false)
    expect(shopifyConfigured({ SHOPIFY_SHOP_DOMAIN: ENV.SHOPIFY_SHOP_DOMAIN })).toBe(false)
    expect(shopifyConfigured({ SHOPIFY_ADMIN_TOKEN: ENV.SHOPIFY_ADMIN_TOKEN })).toBe(false)
    expect(shopifyConfigured({ SHOPIFY_SHOP_DOMAIN: 'not a domain', SHOPIFY_ADMIN_TOKEN: 'x' })).toBe(false)
    expect(shopifyConfigured(ENV)).toBe(true)
    expect(shopifyConfigured({ SHOPIFY_SHOP_DOMAIN: 'https://shop.example.com/', SHOPIFY_ADMIN_TOKEN: 'x' })).toBe(true)
    expect(shopifyConfigured(CC_ENV)).toBe(true)
    expect(shopifyConfigured({ SHOPIFY_SHOP_DOMAIN: CC_ENV.SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID: 'id-only' })).toBe(false)
    expect(shopifyConfigured({ SHOPIFY_SHOP_DOMAIN: CC_ENV.SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_SECRET: 'secret-only' })).toBe(false)
  })

  it('matches the (order number, email) pair and returns a bounded projection without the email', async () => {
    const fetcher = vi.fn(async () => graphqlResponse(ordersPayload([ORDER_NODE])))
    const result = await lookupOrderByNumber(ENV, '#4021', ' Ada@Example.test ', { fetcher: fetcher as unknown as typeof fetch })

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(GRAPHQL_ENDPOINT)
    expect((init.headers as Record<string, string>)['x-shopify-access-token']).toBe(ENV.SHOPIFY_ADMIN_TOKEN)
    expect(String(init.body)).toContain('name:\\"#4021\\" OR name:\\"4021\\"')

    expect(result).toEqual({ status: 'ok', order: ORDER_SUMMARY })
    expect(result.status === 'ok' && 'email' in result.order).toBe(false)
  })

  it('normalizes order-number variants into prefixed and bare name candidates', async () => {
    const fetcher = vi.fn(async () => graphqlResponse(ordersPayload([])))
    await lookupOrderByNumber(ENV, '  # en 1001 ', 'ada@example.test', { fetcher: fetcher as unknown as typeof fetch })
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(init.body)).toContain('name:\\"#EN1001\\" OR name:\\"EN1001\\"')

    await lookupOrderByNumber(ENV, '4021', 'ada@example.test', { fetcher: fetcher as unknown as typeof fetch })
    const [, second] = fetcher.mock.calls[1] as unknown as [string, RequestInit]
    expect(String(second.body)).toContain('name:\\"#4021\\" OR name:\\"4021\\"')
  })

  it('returns byte-identical not_found for an email mismatch and an unknown number', async () => {
    const mismatchFetcher = vi.fn(async () => graphqlResponse(ordersPayload([ORDER_NODE])))
    const mismatch = await lookupOrderByNumber(ENV, '#4021', 'intruder@example.test', {
      fetcher: mismatchFetcher as unknown as typeof fetch,
    })

    const unknownFetcher = vi.fn(async () => graphqlResponse(ordersPayload([])))
    const unknown = await lookupOrderByNumber(ENV, '#9999', 'intruder@example.test', {
      fetcher: unknownFetcher as unknown as typeof fetch,
    })

    expect(mismatch).toEqual({ status: 'not_found' })
    expect(unknown).toEqual({ status: 'not_found' })
    expect(mismatch).toEqual(unknown)
    expect(Object.keys(mismatch)).toEqual(Object.keys(unknown))
  })

  it('rejects unusable order numbers without calling the provider', async () => {
    const fetcher = vi.fn()
    await expect(lookupOrderByNumber(ENV, '   ', 'ada@example.test', { fetcher: fetcher as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'not_found' })
    await expect(lookupOrderByNumber(ENV, `#${'9'.repeat(40)}`, 'ada@example.test', { fetcher: fetcher as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'not_found' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('degrades every provider failure to a typed unavailable result', async () => {
    const http500 = vi.fn(async () => new Response('boom', { status: 500 }))
    await expect(lookupOrderByNumber(ENV, '#4021', 'ada@example.test', { fetcher: http500 as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'unavailable' })

    const graphqlErrors = vi.fn(async () => graphqlResponse({ errors: [{ message: 'boom' }] }))
    await expect(lookupOrderByNumber(ENV, '#4021', 'ada@example.test', { fetcher: graphqlErrors as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'unavailable' })

    const malformed = vi.fn(async () => new Response('not-json', { status: 200 }))
    await expect(lookupOrderByNumber(ENV, '#4021', 'ada@example.test', { fetcher: malformed as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'unavailable' })

    const throwing = vi.fn(async () => { throw new Error('network down') })
    await expect(lookupOrderByNumber(ENV, '#4021', 'ada@example.test', { fetcher: throwing as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'unavailable' })
  })

  it('aborts a slow provider call and reports unavailable', async () => {
    const hanging = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as unknown as typeof fetch
    await expect(lookupOrderByNumber(ENV, '#4021', 'ada@example.test', { fetcher: hanging, timeoutMs: 5 }))
      .resolves.toEqual({ status: 'unavailable' })
  })

  it('never calls the token endpoint on the legacy admin-token path', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/admin/oauth/')) throw new Error('token endpoint must not be called')
      return graphqlResponse(ordersPayload([]))
    })
    await expect(lookupOrderByNumber(ENV, '#4021', 'ada@example.test', { fetcher: fetcher as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'not_found' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe(GRAPHQL_ENDPOINT)
  })
})

describe('deterministic voice order continuation', () => {
  it('recognizes an order-status request and preserves a previously supplied order number', () => {
    expect(isOrderLookupRequest('Where is my order?')).toBe(true)
    expect(isOrderLookupRequest('Can you track order #FC-4021 for me?')).toBe(true)
    expect(isOrderLookupRequest('How do I clean my grinder?')).toBe(false)
    expect(findOrderNumber([
      { role: 'user', content: 'Where is order #FC-4021?' },
      { role: 'assistant', content: 'Add your email in the card below.' },
      { role: 'user', content: 'I have shared my name and email.' },
    ])).toBe('#FC-4021')
  })

  it('renders provider results without asking for contact details again', () => {
    expect(orderStatusReply({ status: 'not_found' })).toContain('email on this session')
    expect(orderStatusReply({ status: 'unavailable' })).toContain('trouble checking orders')
    expect(orderStatusReply({ status: 'ok', order: ORDER_SUMMARY })).toContain('TRACK123')

    for (const result of [
      { status: 'not_found' } as const,
      { status: 'unavailable' } as const,
      { status: 'ok', order: ORDER_SUMMARY } as const,
    ]) {
      expect(orderStatusReply(result)).not.toMatch(/name|email.*card|contact details/i)
    }
  })
})

describe('shopify client credentials grant', () => {
  beforeEach(() => resetShopifyTokenCache())

  function tokenResponse(token: string, expiresIn = 86_399): Response {
    return new Response(JSON.stringify({ access_token: token, scope: 'read_orders', expires_in: expiresIn }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  function scriptedFetcher(script: (url: string, init: RequestInit, call: number) => Response | Promise<Response>) {
    let call = 0
    return vi.fn(async (url: string, init: RequestInit) => script(url, init, call++))
  }

  it('fetches a grant token with the documented form body, then queries with it', async () => {
    const fetcher = scriptedFetcher((url) => {
      if (url === TOKEN_ENDPOINT) return tokenResponse('grant-token-1')
      return graphqlResponse(ordersPayload([ORDER_NODE]))
    })
    const result = await lookupOrderByNumber(CC_ENV, '#4021', 'ada@example.test', { fetcher: fetcher as unknown as typeof fetch })

    expect(result).toEqual({ status: 'ok', order: ORDER_SUMMARY })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [tokenUrl, tokenInit] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(tokenUrl).toBe(TOKEN_ENDPOINT)
    expect((tokenInit.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded')
    expect(String(tokenInit.body)).toBe('client_id=client-id-1&client_secret=client-secret-1&grant_type=client_credentials')
    const [queryUrl, queryInit] = fetcher.mock.calls[1] as [string, RequestInit]
    expect(queryUrl).toBe(GRAPHQL_ENDPOINT)
    expect((queryInit.headers as Record<string, string>)['x-shopify-access-token']).toBe('grant-token-1')
  })

  it('caches the token across lookups and re-fetches only after expiry', async () => {
    const fetcher = scriptedFetcher((url) => {
      if (url === TOKEN_ENDPOINT) return tokenResponse('grant-token-1')
      return graphqlResponse(ordersPayload([]))
    })
    const options = { fetcher: fetcher as unknown as typeof fetch, now: () => 0 }
    await lookupOrderByNumber(CC_ENV, '#4021', 'ada@example.test', options)
    await lookupOrderByNumber(CC_ENV, '#4021', 'ada@example.test', options)
    const tokenCalls = () => fetcher.mock.calls.filter(([url]) => url === TOKEN_ENDPOINT).length
    expect(tokenCalls()).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(3)

    // Beyond the 24h lifetime (minus the safety margin) the grant is re-fetched.
    await lookupOrderByNumber(CC_ENV, '#4021', 'ada@example.test', {
      fetcher: fetcher as unknown as typeof fetch,
      now: () => 86_399_000,
    })
    expect(tokenCalls()).toBe(2)
  })

  it('re-authenticates once and retries once when a cached token is rejected', async () => {
    const fetcher = scriptedFetcher((url, _init, call) => {
      if (url === TOKEN_ENDPOINT) return tokenResponse(call === 0 ? 'grant-token-1' : 'grant-token-2')
      if (call === 1) return new Response('unauthorized', { status: 401 })
      return graphqlResponse(ordersPayload([]))
    })
    const result = await lookupOrderByNumber(CC_ENV, '#4021', 'ada@example.test', { fetcher: fetcher as unknown as typeof fetch })

    expect(result).toEqual({ status: 'not_found' })
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([TOKEN_ENDPOINT, GRAPHQL_ENDPOINT, TOKEN_ENDPOINT, GRAPHQL_ENDPOINT])
    const [, retryInit] = fetcher.mock.calls[3] as [string, RequestInit]
    expect((retryInit.headers as Record<string, string>)['x-shopify-access-token']).toBe('grant-token-2')
  })

  it('degrades to unavailable when the token endpoint fails, without querying', async () => {
    const fetcher = scriptedFetcher((url) => {
      if (url === TOKEN_ENDPOINT) return new Response('nope', { status: 500 })
      throw new Error('query must not run without a token')
    })
    await expect(lookupOrderByNumber(CC_ENV, '#4021', 'ada@example.test', { fetcher: fetcher as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'unavailable' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('gives up after a failed re-authentication instead of looping', async () => {
    const fetcher = scriptedFetcher((url, _init, call) => {
      if (url === TOKEN_ENDPOINT) return call === 0 ? tokenResponse('grant-token-1') : new Response('nope', { status: 403 })
      return new Response('unauthorized', { status: 401 })
    })
    await expect(lookupOrderByNumber(CC_ENV, '#4021', 'ada@example.test', { fetcher: fetcher as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'unavailable' })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})

describe('order read-back session gating', () => {
  it('requires only a session contact and passes the caller number with the server-held email', async () => {
    const lookup = vi.fn(async () => ({ status: 'ok' as const, order: ORDER_SUMMARY }))
    await expect(orderStatusForSession(ENV, { email: 'ada@example.test' }, '#4021', lookup))
      .resolves.toEqual({ status: 'ok', order: ORDER_SUMMARY })
    expect(lookup).toHaveBeenCalledWith(ENV, '#4021', 'ada@example.test')
  })

  it('fails closed without a session contact and never reaches the provider', async () => {
    const lookup = vi.fn(async () => ({ status: 'ok' as const, order: ORDER_SUMMARY }))
    await expect(orderStatusForSession(ENV, { email: null }, '#4021', lookup))
      .resolves.toEqual({ status: 'unavailable' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('passes not_found and unavailable through and never signals verification', async () => {
    const notFound = await orderStatusForSession(ENV, { email: 'ada@example.test' }, '#9999', async () => ({ status: 'not_found' }))
    const unavailable = await orderStatusForSession(ENV, { email: 'ada@example.test' }, '#4021', async () => ({ status: 'unavailable' }))
    expect(notFound).toEqual({ status: 'not_found' })
    expect(unavailable).toEqual({ status: 'unavailable' })
    // Order lookup is authorized by the (number, email) pair; the dormant
    // OTP-verification protocol must never be signalled from this path.
    for (const result of [notFound, unavailable]) {
      expect(result.status).not.toBe('verification_required')
    }
  })
})
