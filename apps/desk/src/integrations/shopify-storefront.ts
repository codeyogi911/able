/**
 * Read-only Shopify Storefront API adapter for public product discovery.
 *
 * Shopify supports tokenless Storefront API access for published products and
 * search. Keeping this adapter on that public surface has two useful safety
 * properties: Ava sees only what a shopper can see, and product discovery does
 * not widen the Admin API credentials used for private order read-back.
 *
 * Provider responses are reduced to bounded, shopper-useful projections. Raw
 * GraphQL errors, product IDs, inventory counts, tags, and metafields never
 * reach the model.
 */

export const SHOPIFY_STOREFRONT_API_VERSION = '2025-10'

const SEARCH_LIMIT = 5
const BUDGET_SEARCH_LIMIT = 12
const VARIANT_LIMIT = 8
const DEFAULT_TIMEOUT_MS = 4_000

type ShopifyStorefrontEnv = {
  SHOPIFY_SHOP_DOMAIN?: string
  /** Optional public Storefront token; product search also supports Shopify's tokenless access. */
  SHOPIFY_STOREFRONT_ACCESS_TOKEN?: string
  SHOPIFY_STOREFRONT_COUNTRY?: string
  SHOPIFY_STOREFRONT_LANGUAGE?: string
}

export type ShopifyMoney = {
  amount: string
  currencyCode: string
}

export type ShopifyProductSummary = {
  handle: string
  title: string
  description: string | null
  vendor: string | null
  productType: string | null
  availableForSale: boolean
  priceRange: { min: ShopifyMoney; max: ShopifyMoney }
  url: string | null
  image: { url: string; altText: string | null } | null
}

export type ShopifyProductDetail = ShopifyProductSummary & {
  options: { name: string; values: string[] }[]
  variants: {
    title: string
    availableForSale: boolean
    price: ShopifyMoney
    compareAtPrice: ShopifyMoney | null
    selectedOptions: { name: string; value: string }[]
  }[]
}

export type ShopifyProductSearchResult =
  | { status: 'ok'; products: ShopifyProductSummary[] }
  | { status: 'no_match' }
  | { status: 'unavailable' }

export type ShopifyProductDetailResult =
  | { status: 'ok'; product: ShopifyProductDetail }
  | { status: 'not_found' }
  | { status: 'unavailable' }

type StorefrontOptions = {
  fetcher?: typeof fetch
  timeoutMs?: number
  shopperBudget?: { amount: number; currencyCode: string }
  requireBundle?: boolean
}

const PRODUCT_CORE_FIELDS = `
  handle
  title
  vendor
  productType
  availableForSale
  onlineStoreUrl
  featuredImage { url altText }
  priceRange {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount currencyCode }
  }
`

const SEARCH_PRODUCTS_QUERY = `query AvaSearchProducts(
  $query: String!
  $first: Int!
  $country: CountryCode
  $language: LanguageCode
) @inContext(country: $country, language: $language) {
  search(
    query: $query
    first: $first
    types: [PRODUCT]
    sortKey: RELEVANCE
    prefix: LAST
    unavailableProducts: LAST
  ) {
    nodes {
      ... on Product {
        ${PRODUCT_CORE_FIELDS}
        description(truncateAt: 500)
      }
    }
  }
}`

const PRODUCT_DETAIL_QUERY = `query AvaProductDetail(
  $handle: String!
  $country: CountryCode
  $language: LanguageCode
) @inContext(country: $country, language: $language) {
  product(handle: $handle) {
    ${PRODUCT_CORE_FIELDS}
    description(truncateAt: 1200)
    options { name values }
    variants(first: ${VARIANT_LIMIT}) {
      nodes {
        title
        availableForSale
        price { amount currencyCode }
        compareAtPrice { amount currencyCode }
        selectedOptions { name value }
      }
    }
  }
}`

function shopHostname(domain: string | undefined): string | null {
  const trimmed = (domain ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  return /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(trimmed) ? trimmed.toLowerCase() : null
}

export function shopifyStorefrontConfigured(env: ShopifyStorefrontEnv): boolean {
  return shopHostname(env.SHOPIFY_SHOP_DOMAIN) !== null
}

function storefrontContext(env: ShopifyStorefrontEnv): Record<string, string> {
  const country = env.SHOPIFY_STOREFRONT_COUNTRY?.trim().toUpperCase()
  const language = env.SHOPIFY_STOREFRONT_LANGUAGE?.trim().toUpperCase()
  return {
    ...(/^[A-Z]{2}$/.test(country ?? '') ? { country: country! } : {}),
    ...(/^[A-Z]{2}(?:_[A-Z]{2})?$/.test(language ?? '') ? { language: language! } : {}),
  }
}

function text(value: unknown, limit = 500): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, limit) : null
}

function url(value: unknown): string | null {
  const candidate = text(value, 1_000)
  if (!candidate) return null
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function money(value: unknown): ShopifyMoney | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const amount = text(record.amount, 40)
  const currencyCode = text(record.currencyCode, 12)
  return amount && currencyCode ? { amount, currencyCode } : null
}

function productSummary(value: unknown, descriptionLimit = 500): ShopifyProductSummary | null {
  if (!value || typeof value !== 'object') return null
  const product = value as Record<string, unknown>
  const handle = text(product.handle, 200)
  const title = text(product.title, 300)
  const range = product.priceRange as Record<string, unknown> | null | undefined
  const min = money(range?.minVariantPrice)
  const max = money(range?.maxVariantPrice)
  if (!handle || !title || !min || !max || typeof product.availableForSale !== 'boolean') return null

  const rawImage = product.featuredImage
  const imageRecord = rawImage && typeof rawImage === 'object' ? rawImage as Record<string, unknown> : null
  const imageUrl = url(imageRecord?.url)

  return {
    handle,
    title,
    description: text(product.description, descriptionLimit),
    vendor: text(product.vendor, 200),
    productType: text(product.productType, 200),
    availableForSale: product.availableForSale,
    priceRange: { min, max },
    url: url(product.onlineStoreUrl),
    image: imageUrl ? { url: imageUrl, altText: text(imageRecord?.altText, 300) } : null,
  }
}

function productDetail(value: unknown): ShopifyProductDetail | null {
  const summary = productSummary(value, 1_200)
  if (!summary || !value || typeof value !== 'object') return null
  const product = value as Record<string, unknown>

  const rawOptions = Array.isArray(product.options) ? product.options : []
  const options = rawOptions.slice(0, 3).flatMap((rawOption) => {
    if (!rawOption || typeof rawOption !== 'object') return []
    const option = rawOption as Record<string, unknown>
    const name = text(option.name, 100)
    if (!name) return []
    const values = (Array.isArray(option.values) ? option.values : [])
      .slice(0, 30)
      .flatMap((value) => text(value, 100) ?? [])
    return [{ name, values }]
  })

  const rawVariants = (product.variants as { nodes?: unknown[] } | null | undefined)?.nodes ?? []
  const variants = (Array.isArray(rawVariants) ? rawVariants : []).slice(0, VARIANT_LIMIT).flatMap((rawVariant) => {
    if (!rawVariant || typeof rawVariant !== 'object') return []
    const variant = rawVariant as Record<string, unknown>
    const title = text(variant.title, 200)
    const price = money(variant.price)
    if (!title || !price || typeof variant.availableForSale !== 'boolean') return []
    const selectedOptions = (Array.isArray(variant.selectedOptions) ? variant.selectedOptions : [])
      .slice(0, 3)
      .flatMap((rawOption) => {
        if (!rawOption || typeof rawOption !== 'object') return []
        const option = rawOption as Record<string, unknown>
        const name = text(option.name, 100)
        const value = text(option.value, 100)
        return name && value ? [{ name, value }] : []
      })
    return [{
      title,
      availableForSale: variant.availableForSale,
      price,
      compareAtPrice: money(variant.compareAtPrice),
      selectedOptions,
    }]
  })

  return { ...summary, options, variants }
}

function logStorefrontOutcome(operation: 'search' | 'detail', outcome: string, detail: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ event: 'shopify_storefront_read', operation, outcome, ...detail }))
}

async function storefrontQuery(
  env: ShopifyStorefrontEnv,
  query: string,
  variables: Record<string, unknown>,
  operation: 'search' | 'detail',
  options: StorefrontOptions,
): Promise<Record<string, unknown> | null> {
  const hostname = shopHostname(env.SHOPIFY_SHOP_DOMAIN)
  if (!hostname) {
    logStorefrontOutcome(operation, 'unconfigured')
    return null
  }

  try {
    const response = await (options.fetcher ?? fetch)(
      `https://${hostname}/api/${SHOPIFY_STOREFRONT_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Able-Desk/1.0',
          ...(env.SHOPIFY_STOREFRONT_ACCESS_TOKEN?.trim()
            ? { 'x-shopify-storefront-access-token': env.SHOPIFY_STOREFRONT_ACCESS_TOKEN.trim() }
            : {}),
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    )
    if (!response.ok) {
      logStorefrontOutcome(operation, 'http_error', { httpStatus: response.status })
      return null
    }
    const payload = await response.json().catch(() => null) as {
      data?: Record<string, unknown>
      errors?: unknown[]
    } | null
    if (!payload?.data || (Array.isArray(payload.errors) && payload.errors.length > 0)) {
      const firstError = Array.isArray(payload?.errors) ? payload.errors[0] : null
      const code = (firstError as { extensions?: { code?: unknown } } | null)?.extensions?.code
      logStorefrontOutcome(operation, 'graphql_errors', { code: typeof code === 'string' ? code : null })
      return null
    }
    return payload.data
  } catch (error) {
    logStorefrontOutcome(operation, 'exception', { name: error instanceof Error ? error.name : null })
    return null
  }
}

/** Search only the products currently exposed by Shopify's public storefront. */
export async function searchStorefrontProducts(
  env: ShopifyStorefrontEnv,
  query: string,
  options: StorefrontOptions = {},
): Promise<ShopifyProductSearchResult> {
  const normalizedQuery = query.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (normalizedQuery.length < 2) return { status: 'no_match' }
  const candidateLimit = options.shopperBudget ? BUDGET_SEARCH_LIMIT : SEARCH_LIMIT
  const data = await storefrontQuery(
    env,
    SEARCH_PRODUCTS_QUERY,
    { query: normalizedQuery, first: candidateLimit, ...storefrontContext(env) },
    'search',
    options,
  )
  if (!data) return { status: 'unavailable' }
  const nodes = (data.search as { nodes?: unknown[] } | null | undefined)?.nodes
  if (!Array.isArray(nodes)) {
    logStorefrontOutcome('search', 'malformed')
    return { status: 'unavailable' }
  }
  const candidates = nodes.slice(0, candidateLimit).flatMap((node) => productSummary(node) ?? [])
  const budgetMatches = options.shopperBudget
    ? candidates.filter((product) => {
        const maximum = Number(product.priceRange.max.amount)
        const withinBudget = product.priceRange.max.currencyCode === options.shopperBudget!.currencyCode
          && Number.isFinite(maximum)
          && maximum <= options.shopperBudget!.amount
        if (!withinBudget) return false
        return !options.requireBundle
          || product.productType?.toLowerCase() === 'bundle'
          || /\b(?:bundle|combo|with|kit)\b/i.test(product.title)
      })
    : []
  const products = [...new Map([...budgetMatches, ...candidates].map((product) => [product.handle, product])).values()]
    .slice(0, SEARCH_LIMIT)
  if (products.length === 0) {
    logStorefrontOutcome('search', 'no_match')
    return { status: 'no_match' }
  }
  logStorefrontOutcome('search', 'ok', { resultCount: products.length })
  return { status: 'ok', products }
}

/** Fetch a bounded public product projection by the opaque handle returned by search. */
export async function getStorefrontProduct(
  env: ShopifyStorefrontEnv,
  handle: string,
  options: StorefrontOptions = {},
): Promise<ShopifyProductDetailResult> {
  const normalizedHandle = handle.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,199}$/.test(normalizedHandle)) return { status: 'not_found' }
  const data = await storefrontQuery(
    env,
    PRODUCT_DETAIL_QUERY,
    { handle: normalizedHandle, ...storefrontContext(env) },
    'detail',
    options,
  )
  if (!data) return { status: 'unavailable' }
  if (data.product === null) {
    logStorefrontOutcome('detail', 'not_found')
    return { status: 'not_found' }
  }
  const product = productDetail(data.product)
  if (!product) {
    logStorefrontOutcome('detail', 'malformed')
    return { status: 'unavailable' }
  }
  logStorefrontOutcome('detail', 'ok')
  return { status: 'ok', product }
}
