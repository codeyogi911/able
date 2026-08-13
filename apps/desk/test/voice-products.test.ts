import { describe, expect, it, vi } from 'vitest'
import {
  getStorefrontProduct,
  searchStorefrontProducts,
  SHOPIFY_STOREFRONT_API_VERSION,
  shopifyStorefrontConfigured,
} from '../src/integrations/shopify-storefront'

const ENV = { SHOPIFY_SHOP_DOMAIN: 'example-store.myshopify.com' }
const ENDPOINT = `https://example-store.myshopify.com/api/${SHOPIFY_STOREFRONT_API_VERSION}/graphql.json`

const PRODUCT = {
  handle: 'quiet-grinder',
  title: 'Quiet Grinder',
  description: 'A compact grinder for home espresso.',
  vendor: 'Example Coffee',
  productType: 'Coffee Grinder',
  availableForSale: true,
  onlineStoreUrl: 'https://shop.example.test/products/quiet-grinder',
  featuredImage: {
    url: 'https://cdn.shopify.com/grinder.jpg',
    altText: 'Black coffee grinder',
  },
  priceRange: {
    minVariantPrice: { amount: '120.00', currencyCode: 'SGD' },
    maxVariantPrice: { amount: '140.00', currencyCode: 'SGD' },
  },
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Shopify storefront product adapter', () => {
  it('is configured by a plausible shop domain and does not require private Admin credentials', () => {
    expect(shopifyStorefrontConfigured({})).toBe(false)
    expect(shopifyStorefrontConfigured({ SHOPIFY_SHOP_DOMAIN: 'not a domain' })).toBe(false)
    expect(shopifyStorefrontConfigured(ENV)).toBe(true)
    expect(shopifyStorefrontConfigured({ SHOPIFY_SHOP_DOMAIN: 'https://Example-Store.myshopify.com/products/x' })).toBe(true)
  })

  it('searches Shopify relevance and returns only a bounded public product projection', async () => {
    const fetcher = vi.fn(async () => response({ search: { nodes: [PRODUCT] } }))
    const result = await searchStorefrontProducts(ENV, ' quiet home espresso grinder ', {
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [endpoint, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(endpoint).toBe(ENDPOINT)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'user-agent': 'Able-Desk/1.0',
    })
    expect(init.headers).not.toHaveProperty('x-shopify-storefront-access-token')
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> }
    expect(body.query).toContain('types: [PRODUCT]')
    expect(body.query).toContain('sortKey: RELEVANCE')
    expect(body.query).toContain('unavailableProducts: LAST')
    expect(body.query).toContain('@inContext(country: $country, language: $language)')
    expect(body.query.match(/description\(truncateAt:/g)).toHaveLength(1)
    expect(body.variables).toEqual({ query: 'quiet home espresso grinder', first: 5 })

    expect(result).toEqual({
      status: 'ok',
      products: [{
        handle: 'quiet-grinder',
        title: 'Quiet Grinder',
        description: 'A compact grinder for home espresso.',
        vendor: 'Example Coffee',
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
    expect(JSON.stringify(result)).not.toMatch(/gid:\/\/|inventory|metafield|tag/i)
  })

  it('localizes shopper-visible data with validated country and language context', async () => {
    const fetcher = vi.fn(async () => response({ search: { nodes: [PRODUCT] } }))
    await searchStorefrontProducts({
      ...ENV,
      SHOPIFY_STOREFRONT_COUNTRY: 'in',
      SHOPIFY_STOREFRONT_LANGUAGE: 'en',
    }, 'grinder', { fetcher: fetcher as unknown as typeof fetch })

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { variables: Record<string, unknown> }
    expect(body.variables).toEqual({ query: 'grinder', first: 5, country: 'IN', language: 'EN' })
  })

  it('looks deeper but still returns five public results when finding a budget-safe bundle', async () => {
    const separate = Array.from({ length: 5 }, (_, index) => ({
      ...PRODUCT,
      handle: `separate-${index}`,
      title: `Separate grinder ${index}`,
      priceRange: {
        minVariantPrice: { amount: '12000.00', currencyCode: 'INR' },
        maxVariantPrice: { amount: '12000.00', currencyCode: 'INR' },
      },
    }))
    const bundle = {
      ...PRODUCT,
      handle: 'machine-with-grinder',
      title: 'Espresso Machine with Grinder',
      priceRange: {
        minVariantPrice: { amount: '43000.00', currencyCode: 'INR' },
        maxVariantPrice: { amount: '44000.00', currencyCode: 'INR' },
      },
    }
    const fetcher = vi.fn(async () => response({ search: { nodes: [...separate, bundle] } }))
    const result = await searchStorefrontProducts(ENV, 'machine grinder', {
      fetcher: fetcher as unknown as typeof fetch,
      shopperBudget: { amount: 45_000, currencyCode: 'INR' },
      requireBundle: true,
    })

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { variables: Record<string, unknown> }
    expect(body.variables.first).toBe(12)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.products).toHaveLength(5)
      expect(result.products[0]?.handle).toBe('machine-with-grinder')
    }
  })

  it('sends an optional dedicated public Storefront token without requiring it', async () => {
    const fetcher = vi.fn(async () => response({ search: { nodes: [] } }))
    await searchStorefrontProducts({
      ...ENV,
      SHOPIFY_STOREFRONT_ACCESS_TOKEN: 'public-storefront-token',
    }, 'grinder', { fetcher: fetcher as unknown as typeof fetch })

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toMatchObject({
      'x-shopify-storefront-access-token': 'public-storefront-token',
    })
    expect(String(init.body)).not.toContain('public-storefront-token')
  })

  it('fetches useful bounded detail by a search-returned handle', async () => {
    const fetcher = vi.fn(async () => response({
      product: {
        ...PRODUCT,
        description: 'Detailed product context.',
        options: [{ name: 'Colour', values: ['Black', 'White'] }],
        variants: {
          nodes: [{
            title: 'Black',
            availableForSale: true,
            price: { amount: '120.00', currencyCode: 'SGD' },
            compareAtPrice: { amount: '135.00', currencyCode: 'SGD' },
            selectedOptions: [{ name: 'Colour', value: 'Black' }],
            sku: 'MUST-NOT-LEAK',
          }],
        },
      },
    }))

    const result = await getStorefrontProduct(ENV, ' Quiet-Grinder ', {
      fetcher: fetcher as unknown as typeof fetch,
    })
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { variables: Record<string, unknown> }
    expect(body.variables).toEqual({ handle: 'quiet-grinder' })
    expect(String(init.body).match(/description\(truncateAt:/g)).toHaveLength(1)
    expect(result).toMatchObject({
      status: 'ok',
      product: {
        handle: 'quiet-grinder',
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
    expect(JSON.stringify(result)).not.toContain('MUST-NOT-LEAK')
  })

  it('does not call Shopify for malformed handles or unusable search text', async () => {
    const fetcher = vi.fn()
    await expect(getStorefrontProduct(ENV, '../private', { fetcher: fetcher as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'not_found' })
    await expect(searchStorefrontProducts(ENV, ' ', { fetcher: fetcher as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'no_match' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('distinguishes no match from outages and bounds slow provider calls', async () => {
    const noMatch = vi.fn(async () => response({ search: { nodes: [] } }))
    await expect(searchStorefrontProducts(ENV, 'missing product', { fetcher: noMatch as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'no_match' })

    const missing = vi.fn(async () => response({ product: null }))
    await expect(getStorefrontProduct(ENV, 'missing-product', { fetcher: missing as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'not_found' })

    const graphqlError = vi.fn(async () => new Response(JSON.stringify({
      data: null,
      errors: [{ message: 'private provider detail' }],
    }), { status: 200 }))
    await expect(searchStorefrontProducts(ENV, 'grinder', { fetcher: graphqlError as unknown as typeof fetch }))
      .resolves.toEqual({ status: 'unavailable' })

    const hanging = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as unknown as typeof fetch
    await expect(searchStorefrontProducts(ENV, 'grinder', { fetcher: hanging, timeoutMs: 5 }))
      .resolves.toEqual({ status: 'unavailable' })
  })
})
