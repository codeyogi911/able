export type Env = Cloudflare.Env & {
  DB: D1Database
  ATTACHMENTS: R2Bucket
  EMAIL: SendEmail
  ASSETS: Fetcher
  PUBLIC_RATE_LIMIT: RateLimit
  /** Workers AI powers cached image and PDF evidence for MCP attachment inspection. */
  AI: Ai
  /** Images creates bounded, metadata-stripped WebP previews for agent vision. */
  IMAGES: ImagesBinding
  /** Durable handoff from intake to attachment intelligence processing. */
  MEDIA_QUEUE: Queue<{ kind: 'process_media' }>
  /** Explicit kill switch for verified browser voice support. */
  ABLE_VOICE_DEMO_ENABLED?: string
  /** Bare Access-protected hostname carrying both /mcp and /ops. */
  ABLE_OPERATOR_HOSTNAME?: string
  /** Access application audience. MCP and /ops fail closed when absent. */
  CF_ACCESS_AUD?: string
  /** Optional issuer pin, for example team.cloudflareaccess.com. */
  CF_ACCESS_TEAM_DOMAIN?: string
  /** First verified identity promoted to admin when no operator exists. */
  ABLE_OWNER_EMAIL?: string
  /** Localhost-only identity for development and Worker tests. */
  ABLE_DEV_EMAIL?: string
  /** Turnstile secret. Public writes fail closed in production when absent. */
  TURNSTILE_SECRET_KEY?: string
  /** Public Turnstile site key supplied through deployment configuration. */
  TURNSTILE_SITE_KEY?: string
  /** HMAC key used to materialize customer capabilities only at send time. */
  CUSTOMER_CAPABILITY_SECRET?: string
  /** Shopify shop hostname (my-store.myshopify.com) for verified voice order read-back. */
  SHOPIFY_SHOP_DOMAIN?: string
  /** Dev Dashboard app Client ID for the OAuth client credentials grant. */
  SHOPIFY_CLIENT_ID?: string
  /** Dev Dashboard app Client Secret for the OAuth client credentials grant. */
  SHOPIFY_CLIENT_SECRET?: string
  /** Legacy custom-app Admin token; still honored as an alternative to the client credentials grant. */
  SHOPIFY_ADMIN_TOKEN?: string
  /** Test-only deterministic voice verification code; never bind this in a deployed environment. */
  VOICE_TEST_OTP_CODE?: string
  /** Meta callback token used only for the WhatsApp webhook GET challenge. */
  WHATSAPP_VERIFY_TOKEN?: string
  /** Meta app secret used to verify X-Hub-Signature-256 on webhook POSTs. */
  WHATSAPP_APP_SECRET?: string
  /** Meta system-user token for the WhatsApp Cloud API. */
  WHATSAPP_ACCESS_TOKEN?: string
  /** Sending phone-number ID selected for this single-tenant deployment. */
  WHATSAPP_PHONE_NUMBER_ID?: string
  /** WhatsApp Business Account ID allowed to deliver webhook events. */
  WHATSAPP_WABA_ID?: string
  TEST_MIGRATIONS?: Array<{ name: string; queries: string[] }>
}

export type Execution = ExecutionContext | { waitUntil(promise: Promise<unknown>): void }
