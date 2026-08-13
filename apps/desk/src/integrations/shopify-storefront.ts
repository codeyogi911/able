/**
 * Read-only Shopify Storefront Catalog MCP adapter for public product discovery.
 *
 * The model receives Able's bounded product projection, never Shopify's raw
 * MCP tool catalog or UCP payload. This keeps provider protocol details,
 * product GIDs, merchandising metadata, and raw errors outside the agent tool
 * surface while letting Shopify own current catalog search and localization.
 */

import { FilterXSS } from 'xss'
import { z } from 'zod'

export const SHOPIFY_UCP_VERSION = '2026-04-08'
export const SHOPIFY_UCP_PROFILE_PATH = '/.well-known/ucp'

const SEARCH_LIMIT = 5
const BUDGET_SEARCH_LIMIT = 12
const VARIANT_LIMIT = 8
const DEFAULT_TIMEOUT_MS = 4_000
const MAX_RESPONSE_BYTES = 512 * 1024
const PRODUCT_REFERENCE_PREFIX = 'shopify_product_'

type ShopifyStorefrontEnv = {
  SHOPIFY_SHOP_DOMAIN?: string
  /** Public profile override for local parity, where localhost cannot be fetched by Shopify. */
  SHOPIFY_UCP_AGENT_PROFILE_URL?: string
  SHOPIFY_STOREFRONT_COUNTRY?: string
  SHOPIFY_STOREFRONT_LANGUAGE?: string
}

export type ShopifyMoney = {
  amount: string
  currencyCode: string
}

export type ShopifyProductSummary = {
  /** Opaque Able reference accepted by get_storefront_product. */
  reference: string
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
  profileUrl?: string | null
  shopperBudget?: { amount: number; currencyCode: string }
  requireBundle?: boolean
}

const descriptionSchema = z.object({
  plain: z.string().optional(),
  html: z.string().optional(),
}).passthrough()

const priceSchema = z.object({
  amount: z.number().int().safe().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).passthrough()

const mediaSchema = z.object({
  type: z.string(),
  url: z.string(),
  alt_text: z.string().optional(),
}).passthrough()

const selectedOptionSchema = z.object({
  name: z.string(),
  label: z.string(),
}).passthrough()

const variantSchema = z.object({
  title: z.string(),
  price: priceSchema,
  list_price: priceSchema.optional(),
  availability: z.object({ available: z.boolean().optional() }).passthrough().optional(),
  options: z.array(selectedOptionSchema).optional(),
}).passthrough()

const productSchema = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/Product\/[A-Za-z0-9._~?=&%-]+$/),
  handle: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,199}$/),
  title: z.string(),
  description: descriptionSchema.optional(),
  url: z.string().optional(),
  categories: z.array(z.object({
    value: z.string(),
    taxonomy: z.string().optional(),
  }).passthrough()).optional(),
  price_range: z.object({ min: priceSchema, max: priceSchema }).passthrough(),
  media: z.array(mediaSchema).optional(),
  options: z.array(z.object({
    name: z.string(),
    values: z.array(z.object({ label: z.string() }).passthrough()),
  }).passthrough()).optional(),
  variants: z.array(variantSchema),
}).passthrough()

const structuredContentSchema = z.object({
  ucp: z.object({ version: z.literal(SHOPIFY_UCP_VERSION) }).passthrough(),
  products: z.array(productSchema).optional(),
  product: productSchema.nullable().optional(),
}).passthrough()

const rpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  result: z.object({
    structuredContent: structuredContentSchema.optional(),
    isError: z.boolean().optional(),
  }).passthrough().optional(),
  error: z.object({ code: z.number() }).passthrough().optional(),
}).passthrough()

const descriptionSanitizer = new FilterXSS({
  whiteList: {},
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style', 'iframe', 'object'],
})

export const SHOPIFY_UCP_AGENT_PROFILE = Object.freeze({
  ucp: {
    version: SHOPIFY_UCP_VERSION,
    capabilities: {
      'dev.ucp.shopping.catalog.search': [{ version: SHOPIFY_UCP_VERSION }],
      'dev.ucp.shopping.catalog.lookup': [{ version: SHOPIFY_UCP_VERSION }],
      'dev.shopify.catalog': [{ version: SHOPIFY_UCP_VERSION }],
    },
  },
})

function shopHostname(domain: string | undefined): string | null {
  const trimmed = (domain ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  return /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(trimmed) ? trimmed.toLowerCase() : null
}

function httpsUrl(value: string | undefined): string | null {
  try {
    const parsed = new URL((value ?? '').trim())
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

export function shopifyStorefrontProfileUrl(env: ShopifyStorefrontEnv, requestOrigin?: string): string | null {
  const override = httpsUrl(env.SHOPIFY_UCP_AGENT_PROFILE_URL)
  if (override) return override
  const origin = httpsUrl(requestOrigin)
  return origin ? new URL(SHOPIFY_UCP_PROFILE_PATH, origin).toString() : null
}

export function shopifyStorefrontConfigured(env: ShopifyStorefrontEnv, requestOrigin?: string): boolean {
  return shopHostname(env.SHOPIFY_SHOP_DOMAIN) !== null
    && shopifyStorefrontProfileUrl(env, requestOrigin) !== null
}

export function shopifyUcpProfileResponse(request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { allow: 'GET, HEAD', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    })
  }
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(SHOPIFY_UCP_AGENT_PROFILE), {
    headers: {
      'cache-control': 'public, max-age=3600',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  })
}

function storefrontContext(env: ShopifyStorefrontEnv): Record<string, string> {
  const country = env.SHOPIFY_STOREFRONT_COUNTRY?.trim().toUpperCase()
  const rawLanguage = env.SHOPIFY_STOREFRONT_LANGUAGE?.trim().replace('_', '-')
  const language = rawLanguage && /^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/.test(rawLanguage)
    ? rawLanguage.split('-').map((part, index) => index === 0 ? part.toLowerCase() : part.toUpperCase()).join('-')
    : null
  return {
    ...(/^[A-Z]{2}$/.test(country ?? '') ? { address_country: country! } : {}),
    ...(language ? { language } : {}),
  }
}

function text(value: unknown, limit = 500): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, limit) : null
}

function description(value: z.infer<typeof descriptionSchema> | undefined, limit: number): string | null {
  const plain = text(value?.plain, limit)
  if (plain) return plain
  const stripped = value?.html ? descriptionSanitizer.process(value.html) : null
  return text(stripped, limit)
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

function currencyFractionDigits(currency: string): number | null {
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
    return typeof digits === 'number' && Number.isInteger(digits) && digits >= 0 && digits <= 6 ? digits : null
  } catch {
    return null
  }
}

function minorAmount(amount: number, currency: string): string | null {
  const digits = currencyFractionDigits(currency)
  if (digits === null || !Number.isSafeInteger(amount) || amount < 0) return null
  if (digits === 0) return String(amount)
  const padded = String(amount).padStart(digits + 1, '0')
  return `${padded.slice(0, -digits)}.${padded.slice(-digits)}`
}

function money(value: z.infer<typeof priceSchema> | undefined): ShopifyMoney | null {
  if (!value) return null
  const amount = minorAmount(value.amount, value.currency)
  return amount ? { amount, currencyCode: value.currency } : null
}

function productReference(id: string): string {
  return PRODUCT_REFERENCE_PREFIX + btoa(id).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function productId(reference: string): string | null {
  if (!reference.startsWith(PRODUCT_REFERENCE_PREFIX)) return null
  try {
    const encoded = reference.slice(PRODUCT_REFERENCE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
    const decoded = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))
    return /^gid:\/\/shopify\/Product\/[A-Za-z0-9._~?=&%-]+$/.test(decoded) ? decoded : null
  } catch {
    return null
  }
}

function productSummary(
  product: z.infer<typeof productSchema>,
  descriptionLimit = 500,
): ShopifyProductSummary | null {
  const min = money(product.price_range.min)
  const max = money(product.price_range.max)
  const title = text(product.title, 300)
  if (!title || !min || !max || min.currencyCode !== max.currencyCode) return null
  const featuredImage = product.media?.find((entry) => entry.type === 'image')
  const imageUrl = url(featuredImage?.url)
  const merchantCategory = product.categories?.find((category) => category.taxonomy === 'merchant')

  return {
    reference: productReference(product.id),
    handle: product.handle.toLowerCase(),
    title,
    description: description(product.description, descriptionLimit),
    vendor: null,
    productType: text(merchantCategory?.value, 200),
    availableForSale: product.variants.some((variant) => variant.availability?.available === true),
    priceRange: { min, max },
    url: url(product.url),
    image: imageUrl ? { url: imageUrl, altText: text(featuredImage?.alt_text, 300) } : null,
  }
}

function productDetail(product: z.infer<typeof productSchema>): ShopifyProductDetail | null {
  const summary = productSummary(product, 1_200)
  if (!summary) return null
  const options = (product.options ?? []).slice(0, 3).flatMap((option) => {
    const name = text(option.name, 100)
    if (!name) return []
    const values = option.values.slice(0, 30).flatMap((entry) => text(entry.label, 100) ?? [])
    return [{ name, values }]
  })
  const variants = product.variants.slice(0, VARIANT_LIMIT).flatMap((variant) => {
    const title = text(variant.title, 200)
    const price = money(variant.price)
    if (!title || !price) return []
    const selectedOptions = (variant.options ?? []).slice(0, 3).flatMap((option) => {
      const name = text(option.name, 100)
      const value = text(option.label, 100)
      return name && value ? [{ name, value }] : []
    })
    return [{
      title,
      availableForSale: variant.availability?.available === true,
      price,
      compareAtPrice: money(variant.list_price),
      selectedOptions,
    }]
  })
  return { ...summary, options, variants }
}

function logStorefrontOutcome(operation: 'search' | 'detail', outcome: string, detail: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ event: 'shopify_storefront_catalog_read', operation, outcome, ...detail })
  if (outcome === 'ok' || outcome === 'no_match' || outcome === 'not_found') {
    console.info(entry)
  } else {
    console.warn(entry)
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error('ResponseTooLarge')
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('ResponseTooLarge')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

async function storefrontTool(
  env: ShopifyStorefrontEnv,
  toolName: 'search_catalog' | 'get_product',
  catalog: Record<string, unknown>,
  operation: 'search' | 'detail',
  options: StorefrontOptions,
): Promise<z.infer<typeof structuredContentSchema> | null> {
  const hostname = shopHostname(env.SHOPIFY_SHOP_DOMAIN)
  const profile = httpsUrl(options.profileUrl ?? env.SHOPIFY_UCP_AGENT_PROFILE_URL)
  if (!hostname || !profile) {
    logStorefrontOutcome(operation, 'unconfigured')
    return null
  }

  try {
    const response = await (options.fetcher ?? fetch)(`https://${hostname}/api/ucp/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'Able-Desk/1.0',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: `${operation}-catalog`,
        params: {
          name: toolName,
          arguments: {
            meta: { 'ucp-agent': { profile } },
            catalog,
          },
        },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (!response.ok) {
      logStorefrontOutcome(operation, 'http_error', { httpStatus: response.status })
      return null
    }
    const parsed = rpcResponseSchema.safeParse(await boundedJson(response))
    if (!parsed.success || parsed.data.error || parsed.data.result?.isError || !parsed.data.result?.structuredContent) {
      logStorefrontOutcome(operation, 'invalid_response')
      return null
    }
    return parsed.data.result.structuredContent
  } catch (error) {
    logStorefrontOutcome(operation, 'exception', { name: error instanceof Error ? error.name : null })
    return null
  }
}

/** Search only products currently exposed by Shopify's merchant-scoped UCP catalog. */
export async function searchStorefrontProducts(
  env: ShopifyStorefrontEnv,
  query: string,
  options: StorefrontOptions = {},
): Promise<ShopifyProductSearchResult> {
  const normalizedQuery = query.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (normalizedQuery.length < 2) return { status: 'no_match' }
  const candidateLimit = options.shopperBudget ? BUDGET_SEARCH_LIMIT : SEARCH_LIMIT
  const data = await storefrontTool(env, 'search_catalog', {
    query: normalizedQuery,
    context: storefrontContext(env),
    filters: { available: true },
    pagination: { limit: candidateLimit },
  }, 'search', options)
  if (!data?.products) return { status: 'unavailable' }
  const candidates = data.products.slice(0, candidateLimit).flatMap((product) => productSummary(product) ?? [])
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
  const products = [...new Map([...budgetMatches, ...candidates].map((product) => [product.reference, product])).values()]
    .slice(0, SEARCH_LIMIT)
  if (products.length === 0) {
    logStorefrontOutcome('search', 'no_match')
    return { status: 'no_match' }
  }
  logStorefrontOutcome('search', 'ok', { resultCount: products.length })
  return { status: 'ok', products }
}

/** Fetch bounded public detail using the opaque reference returned by search. */
export async function getStorefrontProduct(
  env: ShopifyStorefrontEnv,
  reference: string,
  options: StorefrontOptions = {},
): Promise<ShopifyProductDetailResult> {
  const id = productId(reference.trim())
  if (!id) return { status: 'not_found' }
  const data = await storefrontTool(env, 'get_product', {
    id,
    context: storefrontContext(env),
  }, 'detail', options)
  if (!data) return { status: 'unavailable' }
  if (data.product === null) {
    logStorefrontOutcome('detail', 'not_found')
    return { status: 'not_found' }
  }
  if (data.product === undefined) {
    logStorefrontOutcome('detail', 'invalid_response')
    return { status: 'unavailable' }
  }
  const product = productDetail(data.product)
  if (!product) {
    logStorefrontOutcome('detail', 'invalid_response')
    return { status: 'unavailable' }
  }
  logStorefrontOutcome('detail', 'ok')
  return { status: 'ok', product }
}
