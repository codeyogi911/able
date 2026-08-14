import { routeAgentRequest } from 'agents'
import { accessErrorResponse, authenticateAccess } from './access'
import { createMcpHandler } from './adapters/mcp/server'
import { createOpsRoutes } from './adapters/ops'
import { createPortalRoutes } from './adapters/portal'
import { createCrm } from './crm'
import { createCommunications } from './communications'
import { createDirectory } from './directory'
import { createImprovementControl } from './improvement'
import { getDiagnostics } from './diagnostics'
import { deliverOutbox, queueSetupTest } from './email/outbox'
import { ingestEmail } from './email/ingress'
import {
  loadEmailCustomization,
  updateEmailCustomization,
  type EmailNotification,
  type EmailTemplatePatch,
} from './email/templates'
import type { Env } from './env'
import { createHelpdesk, createPublicKnowledge, listActiveCategories } from './helpdesk'
import { loadOpsDiagnostics, operatorWriteIsSameOrigin, updateOperatorRole } from './platform/admin'
import { createOperationLoop } from './operations'
import { cleanupPortalFiles, storePortalFiles } from './platform/files'
import { createCloudflareImagePreviewer, createWorkersAiMediaAnalyzer, processPendingMediaIntelligence } from './platform/media'
import type {
  PortalBranding,
  PortalCustomization,
  PortalCustomizationPatch,
  WorkspaceSettingsPatch,
  WorkspaceSettingsView,
} from './platform/contracts'
import { verifyPublicWrite } from './security/public-write'
import { isLocalUrl, requestSurface } from './security/operator-host'
import { loadWorkspaceSettings, updateWorkspaceSettings, type WorkspaceSettings } from './settings'
import { shopifyConfigured } from './integrations/shopify'
import { SHOPIFY_UCP_PROFILE_PATH, shopifyUcpProfileResponse } from './integrations/shopify-storefront'
import {
  beginShopifyCustomerLogin,
  completeShopifyCustomerLogin,
  SHOPIFY_CUSTOMER_LOGIN_COOKIE,
  SHOPIFY_CUSTOMER_RESUME_COOKIE,
  SHOPIFY_CUSTOMER_SESSION_COOKIE,
  SHOPIFY_LOGIN_TRANSACTION_TTL_SECONDS,
  SHOPIFY_SUPPORT_RESUME_TTL_SECONDS,
  shopifyCustomerConfigured,
  verifyShopifyCustomerSession,
  verifyShopifySupportResume,
} from './identity/shopify-customer'
import { acceptWhatsAppWebhook, verifyWhatsAppWebhook } from './whatsapp/webhook'
import { createCustomerWorkspace } from './suite/customer-workspace'
import { createConversationRouter } from './suite/conversation-routing'
import {
  isVoiceDemoAgentPath,
  voiceBranding,
  voiceDemoEnabled,
  voiceDemoPageResponse,
} from './voice/demo-page'

const LOCAL_CAPABILITY_SECRET = 'able-local-capability-secret-not-for-production'
const FONT_FAMILIES = new Set<WorkspaceSettingsView['fontFamily']>(['system', 'humanist', 'geometric', 'rounded'])
type MediaQueueMessage = { kind: 'process_media' }

function notFoundResponse(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  })
}

function processMedia(env: Env, limit = 4) {
  return processPendingMediaIntelligence(
    env.DB,
    env.ATTACHMENTS,
    env.AI ? createWorkersAiMediaAnalyzer(env.AI) : undefined,
    env.IMAGES ? createCloudflareImagePreviewer(env.IMAGES) : undefined,
    limit,
  )
}

function enqueueMediaProcessing(env: Env, ctx?: ExecutionContext): Promise<void> | void {
  const queued = env.MEDIA_QUEUE.send({ kind: 'process_media' }).then(() => undefined)
  if (ctx) {
    ctx.waitUntil(queued)
    return
  }
  return queued
}

function capabilitySecret(request: Request, env: Env): string {
  if (env.CUSTOMER_CAPABILITY_SECRET) return env.CUSTOMER_CAPABILITY_SECRET
  if (isLocalUrl(new URL(request.url)) || Array.isArray(env.TEST_MIGRATIONS)) return LOCAL_CAPABILITY_SECRET
  return ''
}

function portalOrigin(request: Request, settings: WorkspaceSettings): string {
  if (settings.portalBaseUrl) {
    try {
      const url = new URL(settings.portalBaseUrl)
      if (url.protocol === 'https:' || (url.protocol === 'http:' && isLocalUrl(url))) return url.origin
    } catch {
      // The settings form validates this; fail closed to the request origin if
      // a private import wrote malformed configuration.
    }
  }
  return new URL(request.url).origin
}

function portalBranding(settings: WorkspaceSettings): PortalBranding {
  const fontFamily = FONT_FAMILIES.has(settings.fontFamily as WorkspaceSettingsView['fontFamily'])
    ? settings.fontFamily as WorkspaceSettingsView['fontFamily']
    : 'system'
  return {
    displayName: settings.displayName,
    portalTitle: settings.portalTitle,
    logoUrl: settings.logoUrl,
    faviconUrl: settings.faviconUrl,
    homeUrl: settings.homeUrl,
    accentColor: settings.accentColor,
    canvasColor: settings.canvasColor,
    inkColor: settings.inkColor,
    fontFamily,
  }
}

function portalSettings(
  settings: WorkspaceSettings,
  env: Env,
  publicSecurityReady = true,
  recoveryEmailEnabled = true,
): WorkspaceSettingsView {
  return {
    ...portalBranding(settings),
    supportEmail: settings.supportEmail,
    outboundSender: settings.outboundSender,
    portalBaseUrl: settings.portalBaseUrl,
    casePrefix: settings.casePrefix,
    locale: settings.locale,
    timezone: settings.timezone,
    publicIntakeEnabled: settings.publicIntakeEnabled && publicSecurityReady,
    emailReady: Boolean(settings.emailTestedAt) && publicSecurityReady,
    recoveryEmailEnabled,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
  }
}

function portalCustomization(settings: WorkspaceSettings): PortalCustomization {
  return {
    schemaVersion: 'portal-customization.v1',
    ...portalBranding(settings),
    customCssSupported: false,
  }
}

function readCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') ?? ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=') || null
  }
  return null
}

function authCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`
}

function authRedirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(null, { status: 302, headers })
}

/**
 * The optional verified-identity rail: sign in with the deployment's Shopify
 * customer account. Every failure path lands the visitor back on the portal
 * as anonymous — sign-in never blocks the progressive contact flow.
 */
async function shopifyAuthResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (request.method !== 'GET') return notFoundResponse()
  if (url.pathname === '/auth/shopify/logout') {
    return authRedirect('/', [
      authCookie(SHOPIFY_CUSTOMER_SESSION_COOKIE, '', 0),
      authCookie(SHOPIFY_CUSTOMER_LOGIN_COOKIE, '', 0),
      authCookie(SHOPIFY_CUSTOMER_RESUME_COOKIE, '', 0),
    ])
  }
  const secret = capabilitySecret(request, env)
  if (!shopifyCustomerConfigured(env) || !secret) return notFoundResponse()
  const redirectUri = new URL('/auth/shopify/callback', url.origin).toString()

  if (url.pathname === '/auth/shopify/start') {
    const started = await beginShopifyCustomerLogin(env, {
      redirectUri,
      secret,
      supportSession: url.searchParams.get('support_session'),
    })
    if (!started) {
      return authRedirect('/', [
        authCookie(SHOPIFY_CUSTOMER_LOGIN_COOKIE, '', 0),
        authCookie(SHOPIFY_CUSTOMER_RESUME_COOKIE, '', 0),
      ])
    }
    return authRedirect(started.url, [
      authCookie(SHOPIFY_CUSTOMER_LOGIN_COOKIE, started.transactionToken, SHOPIFY_LOGIN_TRANSACTION_TTL_SECONDS),
    ])
  }

  if (url.pathname === '/auth/shopify/callback') {
    const code = url.searchParams.get('code') ?? ''
    const state = url.searchParams.get('state') ?? ''
    const transactionToken = readCookieValue(request, SHOPIFY_CUSTOMER_LOGIN_COOKIE) ?? ''
    const completed = code && state && transactionToken
      ? await completeShopifyCustomerLogin(env, { code, state, transactionToken, redirectUri, secret })
      : null
    if (!completed) {
      return authRedirect('/', [
        authCookie(SHOPIFY_CUSTOMER_LOGIN_COOKIE, '', 0),
        authCookie(SHOPIFY_CUSTOMER_RESUME_COOKIE, '', 0),
      ])
    }
    const maxAge = Math.max(60, Math.floor((completed.session.expiresAt - Date.now()) / 1000))
    // The marker lets the assistant resume the conversation that requested
    // the sign-in; the client strips it from the URL immediately.
    return authRedirect('/?signed_in=1', [
      authCookie(SHOPIFY_CUSTOMER_SESSION_COOKIE, completed.sessionToken, maxAge),
      authCookie(SHOPIFY_CUSTOMER_LOGIN_COOKIE, '', 0),
      completed.supportResumeToken
        ? authCookie(SHOPIFY_CUSTOMER_RESUME_COOKIE, completed.supportResumeToken, SHOPIFY_SUPPORT_RESUME_TTL_SECONDS)
        : authCookie(SHOPIFY_CUSTOMER_RESUME_COOKIE, '', 0),
    ])
  }

  return notFoundResponse()
}

function rewritePath(request: Request, prefix: string): Request {
  const url = new URL(request.url)
  url.pathname = url.pathname.slice(prefix.length) || '/'
  return new Request(url, request)
}

async function portalResponse(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const settings = await loadWorkspaceSettings(env.DB)
  const publicSecurityReady = isLocalUrl(new URL(request.url)) || Array.isArray(env.TEST_MIGRATIONS) || Boolean(
    env.TURNSTILE_SECRET_KEY
    && env.TURNSTILE_SITE_KEY
    && env.CUSTOMER_CAPABILITY_SECRET
    && env.CUSTOMER_CAPABILITY_SECRET.length >= 32
  )
  const voiceReady = voiceDemoEnabled(env) && publicSecurityReady && Boolean(
    settings.emailTestedAt && settings.outboundSender && settings.supportEmail,
  )
  const url = new URL(request.url)
  const knowledge = createPublicKnowledge(env.DB)
  if (request.method === 'GET' && url.pathname === '/' && voiceReady) {
    const content = await knowledge.home()
    const secret = capabilitySecret(request, env)
    const customerSession = await verifyShopifyCustomerSession(
      secret,
      readCookieValue(request, SHOPIFY_CUSTOMER_SESSION_COOKIE),
    )
    const resumeSessionName = await verifyShopifySupportResume(
      secret,
      readCookieValue(request, SHOPIFY_CUSTOMER_RESUME_COOKIE),
    )
    const response = voiceDemoPageResponse(
      voiceBranding(settings),
      env.TURNSTILE_SITE_KEY,
      shopifyConfigured(env),
      content.sections.map((section) => ({
        slug: section.slug,
        name: section.name,
        description: section.description,
        articles: content.articles
          .filter((article) => article.section === section.name)
          .slice(0, 3)
          .map((article) => ({ slug: article.slug, title: article.title })),
      })),
      {
        configured: shopifyCustomerConfigured(env),
        customerName: customerSession?.name ?? null,
        resumeSessionName,
      },
      settings.locale,
      env.ABLE_LOCAL_VOICE_UNAVAILABLE !== '1',
    )
    response.headers.append('set-cookie', authCookie(SHOPIFY_CUSTOMER_RESUME_COOKIE, '', 0))
    return response
  }
  const helpdesk = createHelpdesk({
    db: env.DB,
    attachments: env.ATTACHMENTS,
    baseUrl: portalOrigin(request, settings),
    capabilitySecret: capabilitySecret(request, env),
    workspaceName: settings.displayName,
  })
  const emailCustomization = await loadEmailCustomization(env.DB)
  const recoveryEmailEnabled = emailCustomization.templates.some(
    (template) => template.notification === 'case_recovery' && template.enabled,
  )
  const app = createPortalRoutes({
    helpdesk,
    settings: portalSettings(settings, env, publicSecurityReady, recoveryEmailEnabled),
    knowledge,
    categories: await listActiveCategories(env.DB),
    verifyPublicWrite: async ({ request: guardedRequest, action, turnstileToken }) => {
      const actionMap = { intake: 'intake', recovery: 'recover', customer_reply: 'reply' } as const
      const result = await verifyPublicWrite(guardedRequest, env, turnstileToken, actionMap[action])
      if (result.ok) return result
      const messages: Record<string, string> = {
        rate_limited: 'Too many attempts were received. Wait a minute and try again.',
        origin_mismatch: 'This form must be submitted from the support portal.',
        turnstile_not_configured: 'Public requests are not configured yet.',
      }
      return { ok: false, message: messages[result.reason] ?? 'Complete the anti-spam check and try again.' }
    },
    storeAttachments: (files, requestId) => storePortalFiles(env.ATTACHMENTS, files, requestId),
    cleanupAttachments: (storageKeys) => cleanupPortalFiles(env.DB, env.ATTACHMENTS, storageKeys),
    customerResource: helpdesk.customerResource.bind(helpdesk),
    voiceEnabled: voiceReady,
    ordersEnabled: shopifyConfigured(env),
  })
  const response = await app.fetch(request, env, ctx)
  if (request.method === 'POST' && new URL(request.url).pathname === '/requests' && response.status < 400) {
    enqueueMediaProcessing(env, ctx)
  }
  return response
}

async function opsResponse(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let actor
  try {
    actor = await authenticateAccess(request, env)
  } catch (error) {
    return accessErrorResponse(error)
  }
  const settings = await loadWorkspaceSettings(env.DB)
  const helpdesk = createHelpdesk({
    db: env.DB,
    attachments: env.ATTACHMENTS,
    baseUrl: portalOrigin(request, settings),
    capabilitySecret: capabilitySecret(request, env),
    workspaceName: settings.displayName,
  })
  const communications = createCommunications({ db: env.DB })
  const app = createOpsRoutes({
    helpdesk,
    communications,
    actor,
    settings: portalSettings(settings, env),
    diagnostics: () => loadOpsDiagnostics(env),
    verifyOperatorWrite: async (writeRequest) => operatorWriteIsSameOrigin(writeRequest),
    updateSettings: async (acting, patch: WorkspaceSettingsPatch) => {
      await updateWorkspaceSettings(env.DB, patch, acting)
    },
    updateOperatorRole: async (acting, operatorId, role) => {
      await updateOperatorRole(env, acting, operatorId, role)
    },
    queueEmailTest: async (acting, recipient) => {
      if (acting.role !== 'admin') throw new Error('Admin access required')
      await queueSetupTest(env.DB, recipient)
      ctx.waitUntil(deliverOutbox(env, 1))
    },
  })
  return app.fetch(rewritePath(request, '/ops'), env, ctx)
}

async function whatsappResponse(request: Request, env: Env): Promise<Response> {
  return acceptWhatsAppWebhook(request, env, createCommunications({ db: env.DB }))
}

async function mcpResponse(request: Request, env: Env): Promise<Response> {
  let actor
  try {
    actor = await authenticateAccess(request, env)
  } catch (error) {
    return accessErrorResponse(error)
  }
  const settings = await loadWorkspaceSettings(env.DB)
  const helpdesk = createHelpdesk({
    db: env.DB,
    attachments: env.ATTACHMENTS,
    baseUrl: portalOrigin(request, settings),
    capabilitySecret: capabilitySecret(request, env),
    workspaceName: settings.displayName,
  })
  const directory = createDirectory({ db: env.DB })
  const crm = createCrm({ db: env.DB, directory })
  const communications = createCommunications({ db: env.DB })
  const conversationRouter = createConversationRouter({ communications, directory, crm, helpdesk })
  const customerWorkspace = createCustomerWorkspace({ helpdesk, directory, crm })
  const operations = createOperationLoop({ db: env.DB })
  const improvements = createImprovementControl({ db: env.DB })
  return createMcpHandler({
    helpdesk,
    communications,
    conversationRouter,
    customerWorkspace,
    crm,
    operations,
    improvements,
    actor,
    diagnostics: () => getDiagnostics(env),
    portalCustomization: {
      read: async () => portalCustomization(await loadWorkspaceSettings(env.DB)),
      update: async (patch: PortalCustomizationPatch) => portalCustomization(
        await updateWorkspaceSettings(env.DB, patch, actor),
      ),
    },
    emailCustomization: {
      read: async () => loadEmailCustomization(env.DB),
      update: async (notification: EmailNotification, patch: EmailTemplatePatch) =>
        updateEmailCustomization(env.DB, notification, patch, actor),
    },
    operatorOrigin: new URL(request.url).origin,
    allowedOrigins: [new URL(request.url).origin],
  })(request)
}

async function fetchHandler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  try {
    const operatorPath = url.pathname === '/mcp' || url.pathname === '/ops' || url.pathname.startsWith('/ops/')
    const surface = requestSurface(url, env.ABLE_OPERATOR_HOSTNAME)
    if (surface === 'operator' && !operatorPath) {
      return notFoundResponse()
    }
    if (operatorPath && surface === 'public') {
      return notFoundResponse()
    }
    if (operatorPath && surface === 'unconfigured') {
      return Response.json(
        { error: 'operator_hostname_not_configured' },
        { status: 503, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } },
      )
    }
    if (url.pathname === '/healthz') {
      return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    }
    if (url.pathname === SHOPIFY_UCP_PROFILE_PATH) {
      return shopifyUcpProfileResponse(request)
    }
    if ((url.pathname === '/voice' || url.pathname === '/demo/voice') && request.method === 'GET') {
      return Response.redirect(new URL('/', request.url), 308)
    }
    if (url.pathname === '/voice' || url.pathname === '/demo/voice' || isVoiceDemoAgentPath(url.pathname)) {
      if (!voiceDemoEnabled(env)) return notFoundResponse()
      const gated = !isLocalUrl(url) && !Array.isArray(env.TEST_MIGRATIONS)
      const settings = gated ? await loadWorkspaceSettings(env.DB) : null
      if (gated && settings) {
        const ready = Boolean(
          env.TURNSTILE_SECRET_KEY
          && env.TURNSTILE_SITE_KEY
          && env.CUSTOMER_CAPABILITY_SECRET
          && env.CUSTOMER_CAPABILITY_SECRET.length >= 32
          && settings.emailTestedAt
          && settings.outboundSender
          && settings.supportEmail
        )
        if (!ready) return notFoundResponse()
      }
      if (!isVoiceDemoAgentPath(url.pathname)) return notFoundResponse()
      return await routeAgentRequest(request, env) ?? notFoundResponse()
    }
    if (url.pathname === '/webhooks/whatsapp' && request.method === 'GET') {
      return verifyWhatsAppWebhook(request, env)
    }
    if (url.pathname === '/webhooks/whatsapp' && request.method === 'POST') {
      return await whatsappResponse(request, env)
    }
    if (url.pathname === '/mcp') return mcpResponse(request, env)
    if (url.pathname === '/ops' || url.pathname.startsWith('/ops/')) return opsResponse(request, env, ctx)
    if (url.pathname.startsWith('/auth/shopify/')) return shopifyAuthResponse(request, env)
    return portalResponse(request, env, ctx)
  } catch (error) {
    console.error(JSON.stringify({ event: 'request_failed', error: error instanceof Error ? error.name : 'UnknownError' }))
    return new Response('The request could not be completed.', {
      status: 503,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
    })
  }
}

async function emailHandler(message: ForwardableEmailMessage, env: Env, ctx?: ExecutionContext): Promise<void> {
  try {
    const settings = await loadWorkspaceSettings(env.DB)
    if (!settings.portalBaseUrl) {
      message.setReject('Support portal is not configured')
      return
    }
    const fakeRequest = new Request(settings.portalBaseUrl)
    const secret = capabilitySecret(fakeRequest, env)
    if (!secret) {
      message.setReject('Support intake is not configured')
      return
    }
    const helpdesk = createHelpdesk({
      db: env.DB,
      attachments: env.ATTACHMENTS,
      baseUrl: settings.portalBaseUrl,
      capabilitySecret: secret,
      workspaceName: settings.displayName,
    })
    const result = await ingestEmail(message, helpdesk, env.ATTACHMENTS)
    if (result.accepted) await enqueueMediaProcessing(env, ctx)
    if (!result.accepted && result.reason !== 'automated_message_suppressed') {
      message.setReject('The support message could not be accepted')
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'email_ingress_failed', error: error instanceof Error ? error.name : 'UnknownError' }))
    message.setReject('The support message could not be accepted')
  }
}

export default {
  fetch: fetchHandler,
  email: emailHandler,
  async queue(batch: MessageBatch<MediaQueueMessage>, env: Env) {
    try {
      const limit = Math.max(4, Math.min(batch.messages.length * 4, 20))
      const result = await processMedia(env, limit)
      if (result.failed > 0) batch.retryAll({ delaySeconds: 60 })
    } catch (error) {
      console.error(JSON.stringify({ event: 'media_queue_failed', error: error instanceof Error ? error.name : 'UnknownError' }))
      batch.retryAll({ delaySeconds: 60 })
    }
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([deliverOutbox(env), processMedia(env, 10)]).then(() => undefined))
  },
} satisfies ExportedHandler<Env, MediaQueueMessage>

export { AbleDeskAgent } from './voice/demo-agent'
