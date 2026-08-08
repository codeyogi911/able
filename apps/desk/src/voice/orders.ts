import { lookupOrderByNumber, type ShopifyOrderResult, type ShopifyOrderSummary } from '../integrations/shopify'

type OrdersEnv = {
  SHOPIFY_SHOP_DOMAIN?: string
  SHOPIFY_ADMIN_TOKEN?: string
  SHOPIFY_CLIENT_ID?: string
  SHOPIFY_CLIENT_SECRET?: string
}

export type VoiceOrderSession = { email: string | null }

export type OrderStatusToolResult =
  | { status: 'ok'; order: ShopifyOrderSummary }
  | { status: 'not_found' }
  | { status: 'unavailable' }

type ConversationMessage = { role: 'user' | 'assistant'; content: string }

// Customers rarely say "order" when they chase a shipment — "my delivery is
// delayed" and "where is my package" are the common phrasings — so the
// deterministic intake matches any shipment noun near a tracking signal.
const ORDER_LOOKUP_NOUN = '(?:order|delivery|package|parcel|shipment)'
const ORDER_LOOKUP_SIGNAL = '(?:where|track|tracking|status|ship(?:s|ped|ping)?|deliver(?:y|ed|ing)?|arrive(?:s|d)?|arrival|late|delay(?:s|ed)?|missing|stuck|lost)'
const ORDER_LOOKUP_REQUEST = new RegExp(
  `\\b${ORDER_LOOKUP_NOUN}\\b.{0,60}\\b${ORDER_LOOKUP_SIGNAL}\\b|\\b${ORDER_LOOKUP_SIGNAL}\\b.{0,60}\\b${ORDER_LOOKUP_NOUN}\\b`,
  'i',
)
// Order names may carry store-configured prefixes and separators, including
// fiscal-year formats such as "#2026-27/7903", so "/" is part of the value.
const ORDER_NUMBER = /(?:\border(?:\s+(?:number|no\.?))?\s*[:#-]?\s*((?=[A-Z0-9/-]*\d)[A-Z0-9][A-Z0-9/-]{1,31})\b|#((?=[A-Z0-9/-]*\d)[A-Z0-9][A-Z0-9/-]{1,31})\b)/i
// A message that is nothing but an order number, as customers reply after
// being asked for one. The token must contain a digit; trailing sentence
// punctuation is tolerated.
const BARE_ORDER_NUMBER = /^#?((?=[A-Z0-9/-]*\d)[A-Z0-9][A-Z0-9/-]{1,31})[.!?]?$/i

export function isOrderLookupRequest(message: string): boolean {
  return ORDER_LOOKUP_REQUEST.test(message)
}

/**
 * The order number when the whole message is one, e.g. "#2026-27/7903" or
 * "2026-27/7903." typed in answer to "what is the order number?" — otherwise
 * null. Normalized to the "#"-prefixed uppercase form used for lookup.
 */
export function bareOrderNumber(message: string): string | null {
  const match = BARE_ORDER_NUMBER.exec(message.trim())
  return match?.[1] ? `#${match[1].toUpperCase()}` : null
}

export function findOrderNumber(messages: ConversationMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const match = ORDER_NUMBER.exec(message.content)
    const value = match?.[1] ?? match?.[2]
    if (value) return `#${value.replace(/^#/, '').toUpperCase()}`
    const bare = bareOrderNumber(message.content)
    if (bare) return bare
  }
  return null
}

type CustomerOrderOverview = {
  name: string
  fulfillmentStatus: string | null
  financialStatus: string | null
  tracking: { number: string | null }[]
}

/**
 * A compact spoken-friendly overview of the signed-in customer's recent
 * orders, used by the deterministic continuation after sign-in.
 */
export function ordersOverviewReply(orders: CustomerOrderOverview[]): string {
  if (orders.length === 0) {
    return 'I could not find any orders on your store account. If the order was placed with a different email, share its order number and I can check it.'
  }
  const lines = orders.slice(0, 5).map((order) => {
    const status = order.fulfillmentStatus?.toLowerCase().replace(/_/g, ' ') ?? order.financialStatus?.toLowerCase() ?? null
    const tracking = order.tracking.map((entry) => entry.number).filter((value): value is string => value !== null)
    return `${order.name}${status ? ` — ${status}` : ''}${tracking.length > 0 ? `, tracking ${tracking.join(', ')}` : ''}`
  })
  if (lines.length === 1) return `I found your order ${lines[0]}. Is this the one you mean?`
  return `Here are your recent orders: ${lines.join('; ')}. Which one do you mean?`
}

export function orderStatusReply(result: OrderStatusToolResult): string {
  if (result.status === 'not_found') {
    return 'I could not find that order for the email on this session. Double-check the order number, or start over with the email used at checkout. I can also open a support ticket for the team.'
  }
  if (result.status === 'unavailable') {
    return 'I’m having trouble checking orders right now. I can open a support ticket so the team can follow up.'
  }

  const { order } = result
  const statuses = [
    order.financialStatus ? `payment is ${order.financialStatus.toLowerCase()}` : null,
    order.fulfillmentStatus ? `fulfillment is ${order.fulfillmentStatus.toLowerCase()}` : null,
  ].filter((value): value is string => value !== null)
  const tracking = order.tracking
    .map((entry) => entry.number)
    .filter((value): value is string => value !== null)
  const statusCopy = statuses.length > 0 ? ` ${statuses.join(' and ')}.` : ''
  const trackingCopy = tracking.length > 0 ? ` Tracking number: ${tracking.join(', ')}.` : ''
  return `I found ${order.name}.${statusCopy}${trackingCopy}`
}

/**
 * Order read-back authorization is possession of the (order number, contact
 * email) pair — the same standard as Shopify's own order-status page. The
 * server-held contact email is the only email the lookup can use; the adapter
 * returns an identical 'not_found' for unknown numbers and email mismatches,
 * so nothing here can oracle which order numbers exist. No OTP verification is
 * required on this path (the verification protocol stays dormant for future
 * capabilities).
 */
export async function orderStatusForSession(
  env: OrdersEnv,
  session: VoiceOrderSession,
  orderNumber: string,
  lookup: (env: OrdersEnv, orderNumber: string, email: string) => Promise<ShopifyOrderResult> = lookupOrderByNumber,
): Promise<OrderStatusToolResult> {
  if (!session.email) {
    console.warn(JSON.stringify({ event: 'shopify_order_lookup', outcome: 'no_session_email' }))
    return { status: 'unavailable' }
  }
  return lookup(env, orderNumber, session.email)
}
