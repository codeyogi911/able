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

const ORDER_LOOKUP_REQUEST = /(?:\b(?:where|track|tracking|status|shipped|delivery|arrive|arrival)\b.{0,60}\border\b|\border\b.{0,60}\b(?:where|track|tracking|status|shipped|delivery|arrive|arrival)\b)/i
const ORDER_NUMBER = /(?:\border(?:\s+(?:number|no\.?))?\s*[:#-]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{1,31})\b|#((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{1,31})\b)/i

export function isOrderLookupRequest(message: string): boolean {
  return ORDER_LOOKUP_REQUEST.test(message)
}

export function findOrderNumber(messages: ConversationMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const match = ORDER_NUMBER.exec(message.content)
    const value = match?.[1] ?? match?.[2]
    if (value) return `#${value.replace(/^#/, '').toUpperCase()}`
  }
  return null
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
