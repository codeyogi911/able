import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { SHOPIFY_CUSTOMER_LOGIN_COOKIE, SHOPIFY_CUSTOMER_SESSION_COOKIE } from '../src/identity/shopify-customer'

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie?.() ?? []
}

describe('shopify customer sign-in routes', () => {
  it('clears both cookies on logout and lands on the portal', async () => {
    const response = await SELF.fetch('http://localhost/auth/shopify/logout', { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
    const cookies = setCookies(response)
    expect(cookies.some((cookie) => cookie.startsWith(`${SHOPIFY_CUSTOMER_SESSION_COOKIE}=;`) && cookie.includes('Max-Age=0'))).toBe(true)
    expect(cookies.some((cookie) => cookie.startsWith(`${SHOPIFY_CUSTOMER_LOGIN_COOKIE}=;`) && cookie.includes('Max-Age=0'))).toBe(true)
  })

  it('lands a callback without a login transaction back on the portal as anonymous', async () => {
    const response = await SELF.fetch('http://localhost/auth/shopify/callback?code=x&state=y', { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
    expect(setCookies(response).some((cookie) => cookie.includes(`${SHOPIFY_CUSTOMER_SESSION_COOKIE}=`) && !cookie.includes('Max-Age=0'))).toBe(false)
  })

  it('fails start safely back to the portal when discovery is unreachable', async () => {
    // The test runtime cannot reach the example shop domain, so login begin
    // returns null; the visitor must land on the portal, not an error page.
    const response = await SELF.fetch('http://localhost/auth/shopify/start', { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
  })

  it('rejects non-GET methods', async () => {
    const response = await SELF.fetch('http://localhost/auth/shopify/start', { method: 'POST', redirect: 'manual' })
    expect(response.status).toBe(404)
  })
})
