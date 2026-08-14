import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  beginShopifyCustomerLogin,
  completeShopifyCustomerLogin,
  resetShopifyCustomerDiscoveryCache,
  shopifyCustomerConfigured,
  shopifyCustomerContext,
  signShopifyCustomerSession,
  verifyShopifyCustomerSession,
  verifyShopifySupportResume,
} from '../src/identity/shopify-customer'

const ENV = { SHOPIFY_SHOP_DOMAIN: 'shop.example.test', SHOPIFY_CUSTOMER_CLIENT_ID: 'client-123' }
// Deliberately low-entropy plain words: the public-history secret scan must
// never mistake this test fixture for a real signing key.
const SECRET = 'test-cookie-signing-words-only'
const REDIRECT = 'https://support.example.test/auth/shopify/callback'

function discoveryFetcher(overrides: Record<string, unknown> = {}): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Response.json({
        authorization_endpoint: 'https://auth.example.test/oauth/authorize',
        token_endpoint: 'https://auth.example.test/oauth/token',
      })
    }
    if (url.endsWith('/.well-known/customer-account-api')) {
      return Response.json({ graphql_api: 'https://api.example.test/customer/graphql' })
    }
    if (url === 'https://auth.example.test/oauth/token') {
      return Response.json({ access_token: 'shcat-token', expires_in: 1800, ...overrides['token'] as object })
    }
    if (url === 'https://api.example.test/customer/graphql') {
      return Response.json(overrides['graphql'] ?? {
        data: {
          customer: {
            displayName: 'Rhea Kapoor',
            emailAddress: { emailAddress: 'rhea@example.test' },
            orders: {
              nodes: [{
                name: '#2026-27/7903',
                processedAt: '2026-08-07T07:14:45Z',
                financialStatus: 'PAID',
                fulfillmentStatus: 'FULFILLED',
                totalPrice: { amount: '4997.0', currencyCode: 'INR' },
                lineItems: { nodes: [{ name: 'Grinder', quantity: 1 }] },
                fulfillments: { nodes: [{ trackingInformation: [{ number: 'TRACK9', url: 'https://track.example.test/9' }] }] },
              }],
            },
          },
        },
      })
    }
    return new Response('not found', { status: 404 })
  })
}

beforeEach(() => resetShopifyCustomerDiscoveryCache())

describe('shopify customer sign-in configuration', () => {
  it('activates only with a shop domain and a customer client id', () => {
    expect(shopifyCustomerConfigured(ENV)).toBe(true)
    expect(shopifyCustomerConfigured({ SHOPIFY_SHOP_DOMAIN: 'shop.example.test' })).toBe(false)
    expect(shopifyCustomerConfigured({ SHOPIFY_CUSTOMER_CLIENT_ID: 'client-123' })).toBe(false)
    expect(shopifyCustomerConfigured({})).toBe(false)
  })
})

describe('login begin and completion', () => {
  it('builds a PKCE authorization redirect whose state matches the signed transaction', async () => {
    const fetcher = discoveryFetcher()
    const started = await beginShopifyCustomerLogin(ENV, { redirectUri: REDIRECT, secret: SECRET }, { fetcher })
    expect(started).not.toBeNull()
    const url = new URL(started!.url)
    expect(url.origin + url.pathname).toBe('https://auth.example.test/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-123')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('state')).toBeTruthy()

    const completed = await completeShopifyCustomerLogin(ENV, {
      code: 'auth-code',
      state: url.searchParams.get('state')!,
      transactionToken: started!.transactionToken,
      redirectUri: REDIRECT,
      secret: SECRET,
    }, { fetcher })
    expect(completed).not.toBeNull()
    expect(completed!.session).toMatchObject({ name: 'Rhea Kapoor', email: 'rhea@example.test', accessToken: 'shcat-token' })

    const verified = await verifyShopifyCustomerSession(SECRET, completed!.sessionToken)
    expect(verified).toMatchObject({ email: 'rhea@example.test' })
  })

  it('binds a support conversation to the signed OAuth round trip', async () => {
    const fetcher = discoveryFetcher()
    const supportSession = `voice-${'a'.repeat(20)}`
    const started = await beginShopifyCustomerLogin(
      ENV,
      { redirectUri: REDIRECT, secret: SECRET, supportSession },
      { fetcher, now: () => 1_000 },
    )
    const state = new URL(started!.url).searchParams.get('state')!
    const completed = await completeShopifyCustomerLogin(ENV, {
      code: 'auth-code',
      state,
      transactionToken: started!.transactionToken,
      redirectUri: REDIRECT,
      secret: SECRET,
    }, { fetcher, now: () => 1_000 })

    expect(completed?.supportResumeToken).toBeTruthy()
    expect(await verifyShopifySupportResume(SECRET, completed?.supportResumeToken, 1_001)).toBe(supportSession)
    expect(await verifyShopifySupportResume(SECRET, completed?.supportResumeToken, 1_000 + 121_000)).toBeNull()
    expect(await verifyShopifySupportResume('wrong-secret', completed?.supportResumeToken, 1_001)).toBeNull()
  })

  it('does not bind malformed support session names into OAuth state', async () => {
    const fetcher = discoveryFetcher()
    const started = await beginShopifyCustomerLogin(
      ENV,
      { redirectUri: REDIRECT, secret: SECRET, supportSession: '../../another-agent' },
      { fetcher },
    )
    const state = new URL(started!.url).searchParams.get('state')!
    const completed = await completeShopifyCustomerLogin(ENV, {
      code: 'auth-code',
      state,
      transactionToken: started!.transactionToken,
      redirectUri: REDIRECT,
      secret: SECRET,
    }, { fetcher })
    expect(completed?.supportResumeToken).toBeNull()
  })

  it('rejects a state that does not match the signed transaction', async () => {
    const fetcher = discoveryFetcher()
    const started = await beginShopifyCustomerLogin(ENV, { redirectUri: REDIRECT, secret: SECRET }, { fetcher })
    const completed = await completeShopifyCustomerLogin(ENV, {
      code: 'auth-code',
      state: 'forged-state',
      transactionToken: started!.transactionToken,
      redirectUri: REDIRECT,
      secret: SECRET,
    }, { fetcher })
    expect(completed).toBeNull()
  })

  it('rejects an expired login transaction', async () => {
    const fetcher = discoveryFetcher()
    const started = await beginShopifyCustomerLogin(ENV, { redirectUri: REDIRECT, secret: SECRET }, { fetcher, now: () => 1_000 })
    const state = new URL(started!.url).searchParams.get('state')!
    const completed = await completeShopifyCustomerLogin(ENV, {
      code: 'auth-code',
      state,
      transactionToken: started!.transactionToken,
      redirectUri: REDIRECT,
      secret: SECRET,
    }, { fetcher, now: () => 1_000 + 11 * 60_000 })
    expect(completed).toBeNull()
  })

  it('refuses a session when the store returns no customer email', async () => {
    const fetcher = discoveryFetcher({
      graphql: { data: { customer: { displayName: 'No Email', emailAddress: null, orders: { nodes: [] } } } },
    })
    const started = await beginShopifyCustomerLogin(ENV, { redirectUri: REDIRECT, secret: SECRET }, { fetcher })
    const state = new URL(started!.url).searchParams.get('state')!
    const completed = await completeShopifyCustomerLogin(ENV, {
      code: 'auth-code',
      state,
      transactionToken: started!.transactionToken,
      redirectUri: REDIRECT,
      secret: SECRET,
    }, { fetcher })
    expect(completed).toBeNull()
  })
})

describe('session token boundary', () => {
  const session = { name: 'Rhea', email: 'rhea@example.test', accessToken: 'shcat-token', expiresAt: Date.now() + 60_000 }

  it('round-trips a signed session and rejects tampering and expiry', async () => {
    const token = await signShopifyCustomerSession(SECRET, session)
    expect(await verifyShopifyCustomerSession(SECRET, token)).toMatchObject({ email: 'rhea@example.test' })
    expect(await verifyShopifyCustomerSession('other-secret', token)).toBeNull()
    expect(await verifyShopifyCustomerSession(SECRET, `${token}x`)).toBeNull()
    expect(await verifyShopifyCustomerSession(SECRET, token, session.expiresAt + 1)).toBeNull()
    expect(await verifyShopifyCustomerSession(SECRET, null)).toBeNull()
  })
})

describe('bounded customer context', () => {
  it('projects profile, orders, line items, and tracking without extra fields', async () => {
    const result = await shopifyCustomerContext(ENV, 'shcat-token', { fetcher: discoveryFetcher() })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.customer).toMatchObject({ name: 'Rhea Kapoor', email: 'rhea@example.test' })
    expect(result.customer.orders).toHaveLength(1)
    expect(result.customer.orders[0]).toMatchObject({
      name: '#2026-27/7903',
      financialStatus: 'PAID',
      fulfillmentStatus: 'FULFILLED',
      total: { amount: '4997.0', currencyCode: 'INR' },
      lineItems: [{ title: 'Grinder', quantity: 1 }],
      tracking: [{ number: 'TRACK9', url: 'https://track.example.test/9' }],
    })
  })

  it('turns provider errors into a typed unavailable result', async () => {
    const failing = vi.fn<typeof fetch>(async (input) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('.well-known')) return discoveryFetcher()(input as never)
      return new Response('boom', { status: 500 })
    })
    expect(await shopifyCustomerContext(ENV, 'shcat-token', { fetcher: failing })).toEqual({ status: 'unavailable' })
    expect(await shopifyCustomerContext({}, 'shcat-token', { fetcher: discoveryFetcher() })).toEqual({ status: 'unavailable' })
  })
})
