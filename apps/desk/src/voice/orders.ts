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
