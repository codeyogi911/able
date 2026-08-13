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
  /** Public Able UCP profile override for local parity; deployments derive it from the portal origin. */
  SHOPIFY_UCP_AGENT_PROFILE_URL?: string
  /** Optional ISO 3166-1 alpha-2 country used for localized Storefront prices and availability. */
  SHOPIFY_STOREFRONT_COUNTRY?: string
  /** Optional BCP 47 language tag used for localized Storefront content. */
  SHOPIFY_STOREFRONT_LANGUAGE?: string
  /** Customer Account API public client ID enabling optional customer sign-in on the support portal. */
  SHOPIFY_CUSTOMER_CLIENT_ID?: string
  /** Optional comma-separated product and brand vocabulary boosted by streaming speech recognition. */
  ABLE_VOICE_KEYTERMS?: string
  /** Deepgram API credential enabling an optional Indian-English Flux TTS voice. */
  DEEPGRAM_API_KEY?: string
  /** Optional Deepgram Flux TTS voice model; defaults to flux-priya-en. */
  ABLE_VOICE_TTS_MODEL?: string
  /** Local-parity guard: streaming Workers AI WebSockets require remote Worker execution. */
  ABLE_LOCAL_VOICE_UNAVAILABLE?: string
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
