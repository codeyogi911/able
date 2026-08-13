import { describe, expect, it, vi } from 'vitest'
import {
  getStorefrontProduct,
  searchStorefrontProducts,
  SHOPIFY_UCP_VERSION,
  shopifyStorefrontConfigured,
  shopifyStorefrontProfileUrl,
} from '../src/integrations/shopify-storefront'

const PROFILE_URL = 'https://support.example.test/.well-known/ucp'
const ENV = {
  SHOPIFY_SHOP_DOMAIN: 'example-store.myshopify.com',
  SHOPIFY_UCP_AGENT_PROFILE_URL: PROFILE_URL,
}
const ENDPOINT = 'https://example-store.myshopify.com/api/ucp/mcp'

const PRODUCT = {
  id: 'gid://shopify/Product/1001',
  handle: 'quiet-grinder',
  title: 'Quiet Grinder',
  description: { plain: 'A compact grinder for home espresso.' },
  url: 'https://shop.example.test/products/quiet-grinder',
  categories: [{ value: 'Coffee Grinder', taxonomy: 'merchant' }],
  price_range: {
    min: { amount: 12_000, currency: 'SGD' },
    max: { amount: 14_000, currency: 'SGD' },
  },
  media: [{
    type: 'image',
    url: 'https://cdn.shopify.com/grinder.jpg',
    alt_text: 'Black coffee grinder',
  }],
  options: [{ name: 'Colour', values: [{ label: 'Black' }, { label: 'White' }] }],
  variants: [{
    id: 'gid://shopify/ProductVariant/2001',
    title: 'Black',
    description: { plain: 'Black grinder' },
    price: { amount: 12_000, currency: 'SGD' },
    list_price: { amount: 13_500, currency: 'SGD' },
    availability: { available: true },
    options: [{ name: 'Colour', label: 'Black' }],
    sku: 'MUST-NOT-LEAK',
  }],
}

const PRODUCT_REFERENCE = `shopify_product_${btoa(PRODUCT.id).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`

function response(structuredContent: unknown, options: { isError?: boolean; status?: number } = {}): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 'catalog-test',
    result: { structuredContent, ...(options.isError ? { isError: true } : {}) },
  }), {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

function content(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ucp: {
      version: SHOPIFY_UCP_VERSION,
      capabilities: { 'dev.ucp.shopping.catalog.search': [{ version: SHOPIFY_UCP_VERSION }] },
    },
    ...value,
  }
}

describe('Shopify storefront UCP product adapter', () => {
  it('requires a plausible shop domain and a public Able agent profile', () => {
    expect(shopifyStorefrontConfigured({})).toBe(false)
    expect(shopifyStorefrontConfigured({ SHOPIFY_SHOP_DOMAIN: 'not a domain' }, 'https://support.example.test')).toBe(false)
    expect(shopifyStorefrontConfigured({ SHOPIFY_SHOP_DOMAIN: 'example-store.myshopify.com' })).toBe(false)
    expect(shopifyStorefrontConfigured(ENV)).toBe(true)
    expect(shopifyStorefrontConfigured(
      { SHOPIFY_SHOP_DOMAIN: 'https://Example-Store.myshopify.com/products/x' },
      'https://support.example.test',
    )).toBe(true)
    expect(shopifyStorefrontConfigured(
      { SHOPIFY_SHOP_DOMAIN: 'example-store.myshopify.com' },
      'http://localhost:8787',
    )).toBe(false)
    expect(shopifyStorefrontProfileUrl({}, 'https://support.example.test')).toBe(PROFILE_URL)
  })

  it('calls merchant-scoped Catalog MCP and returns only a bounded public projection', async () => {
    const fetcher = vi.fn(async () => response(content({ products: [PRODUCT] })))
    const result = await searchStorefrontProducts(ENV, ' quiet home espresso grinder ', {
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [endpoint, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(endpoint).toBe(ENDPOINT)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'Able-Desk/1.0',
    })
    const body = JSON.parse(String(init.body)) as {
      jsonrpc: string
      method: string
      params: { name: string; arguments: { meta: Record<string, unknown>; catalog: Record<string, unknown> } }
    }
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'search_catalog',
        arguments: {
          meta: { 'ucp-agent': { profile: PROFILE_URL } },
          catalog: {
            query: 'quiet home espresso grinder',
            context: {},
            filters: { available: true },
            pagination: { limit: 5 },
          },
        },
      },
    })

    expect(result).toEqual({
      status: 'ok',
      products: [{
        reference: PRODUCT_REFERENCE,
        handle: 'quiet-grinder',
        title: 'Quiet Grinder',
        description: 'A compact grinder for home espresso.',
        vendor: null,
        productType: 'Coffee Grinder',
        availableForSale: true,
        priceRange: {
          min: { amount: '120.00', currencyCode: 'SGD' },
          max: { amount: '140.00', currencyCode: 'SGD' },
        },
        url: 'https://shop.example.test/products/quiet-grinder',
        image: { url: 'https://cdn.shopify.com/grinder.jpg', altText: 'Black coffee grinder' },
      }],
    })
    expect(JSON.stringify(result)).not.toMatch(/gid:\/\/|inventory|metafield|sku|tag/i)
  })

  it('localizes catalog reads with validated UCP country and BCP 47 language context', async () => {
    const fetcher = vi.fn(async () => response(content({ products: [PRODUCT] })))
    await searchStorefrontProducts({
      ...ENV,
      SHOPIFY_STOREFRONT_COUNTRY: 'in',
      SHOPIFY_STOREFRONT_LANGUAGE: 'en_in',
    }, 'grinder', { fetcher: fetcher as unknown as typeof fetch })

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as {
      params: { arguments: { catalog: { context: Record<string, unknown> } } }
    }
    expect(body.params.arguments.catalog.context).toEqual({ address_country: 'IN', language: 'en-IN' })
  })

  it('looks deeper but still returns five products when finding a budget-safe bundle', async () => {
    const separate = Array.from({ length: 5 }, (_, index) => ({
      ...PRODUCT,
      id: `gid://shopify/Product/30${index}`,
      handle: `separate-${index}`,
      title: `Separate grinder ${index}`,
      price_range: {
        min: { amount: 1_200_000, currency: 'INR' },
        max: { amount: 1_200_000, currency: 'INR' },
      },
      variants: [{
        ...PRODUCT.variants[0],
        id: `gid://shopify/ProductVariant/40${index}`,
        price: { amount: 1_200_000, currency: 'INR' },
      }],
    }))
    const bundle = {
      ...PRODUCT,
      id: 'gid://shopify/Product/399',
      handle: 'machine-with-grinder',
      title: 'Espresso Machine with Grinder',
      price_range: {
        min: { amount: 4_300_000, currency: 'INR' },
        max: { amount: 4_400_000, currency: 'INR' },
      },
      variants: [{
        ...PRODUCT.variants[0],
        id: 'gid://shopify/ProductVariant/499',
        price: { amount: 4_300_000, currency: 'INR' },
      }],
    }
    const fetcher = vi.fn(async () => response(content({ products: [...separate, bundle] })))
    const result = await searchStorefrontProducts(ENV, 'machine grinder', {
      fetcher: fetcher as unknown as typeof fetch,
      shopperBudget: { amount: 45_000, currencyCode: 'INR' },
      requireBundle: true,
    })

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as {
      params: { arguments: { catalog: { pagination: { limit: number } } } }
    }
    expect(body.params.arguments.catalog.pagination.limit).toBe(12)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.products).toHaveLength(5)
      expect(result.products[0]?.handle).toBe('machine-with-grinder')
      expect(result.products[0]?.priceRange.max.amount).toBe('44000.00')
    }
  })

  it('fetches bounded detail by the opaque reference returned from search', async () => {
    const fetcher = vi.fn(async () => response(content({
      product: {
        ...PRODUCT,
        description: { html: '<p>Detailed <strong>product</strong> context.</p><script>private()</script>' },
      },
    })))

    const result = await getStorefrontProduct(ENV, PRODUCT_REFERENCE, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as {
      params: { name: string; arguments: { catalog: Record<string, unknown> } }
    }
    expect(body.params.name).toBe('get_product')
    expect(body.params.arguments.catalog).toEqual({ id: PRODUCT.id, context: {} })
    expect(result).toMatchObject({
      status: 'ok',
      product: {
        reference: PRODUCT_REFERENCE,
        handle: 'quiet-grinder',
        description: 'Detailed product context.',
        options: [{ name: 'Colour', values: ['Black', 'White'] }],
        variants: [{
          title: 'Black',
          availableForSale: true,
          price: { amount: '120.00', currencyCode: 'SGD' },
          compareAtPrice: { amount: '135.00', currencyCode: 'SGD' },
          selectedOptions: [{ name: 'Colour', value: 'Black' }],
        }],
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/MUST-NOT-LEAK|gid:\/\//)
  })

  it('does not call Shopify for malformed references or unusable search text', async () => {
    const fetcher = vi.fn()
    await expect(getStorefrontProduct(ENV, '../private', { fetcher: fetcher as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'not_found' })
    await expect(searchStorefrontProducts(ENV, ' ', { fetcher: fetcher as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'no_match' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('distinguishes no match from outages and bounds provider responses', async () => {
    const noMatch = vi.fn(async () => response(content({ products: [] })))
    await expect(searchStorefrontProducts(ENV, 'missing product', { fetcher: noMatch as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'no_match' })

    const missing = vi.fn(async () => response(content({ product: null })))
    await expect(getStorefrontProduct(ENV, PRODUCT_REFERENCE, { fetcher: missing as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'not_found' })

    const rpcError = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 'catalog-test',
      error: { code: -32603, message: 'private provider detail' },
    }), { status: 200 }))
    await expect(searchStorefrontProducts(ENV, 'grinder', { fetcher: rpcError as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'unavailable' })

    const oversized = vi.fn(async () => new Response('{}', {
      headers: { 'content-length': String(512 * 1024 + 1) },
    }))
    await expect(searchStorefrontProducts(ENV, 'grinder', { fetcher: oversized as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'unavailable' })

    const hanging = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as unknown as typeof fetch
    await expect(searchStorefrontProducts(ENV, 'grinder', { fetcher: hanging, timeoutMs: 5 }))
      .resolves.toEqual({ status: 'unavailable' })
  })
})
