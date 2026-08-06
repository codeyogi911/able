import { Hono } from 'hono'
import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'

import type {
  Actor,
  CaseRef,
  CaseRevision,
  CaseWorkspace,
  Helpdesk,
} from '../src/domain/types'
import {
  createPortalRoutes,
  type PublicKnowledge,
  type WorkspaceSettingsView,
} from '../src/adapters/portal'
import {
  createOpsRoutes,
  type OpsDiagnostics,
} from '../src/adapters/ops'
import { createCommunications } from '../src/communications'
import { cleanupPortalFiles, storePortalFiles } from '../src/platform/files'

const settings: WorkspaceSettingsView = {
  displayName: 'Able Desk',
  portalTitle: 'Support that keeps its word.',
  logoUrl: null,
  faviconUrl: null,
  homeUrl: null,
  outboundSender: 'support@example.test',
  portalBaseUrl: 'https://support.example.test',
  casePrefix: 'MD',
  locale: 'en',
  timezone: 'UTC',
  accentColor: '#c75936',
  canvasColor: '#f3efe7',
  inkColor: '#1d1d1b',
  fontFamily: 'system',
  publicIntakeEnabled: true,
  emailReady: true,
}

const operator: Actor = {
  id: 'operator-1',
  email: 'operator@example.test',
  name: 'Morgan Lee',
  role: 'admin',
}

const workspace: CaseWorkspace = {
  kind: 'case',
  ref: 'MD-42' as CaseRef,
  revision: 'rev-7' as CaseRevision,
  subject: 'Shipment arrived with a cracked handle',
  status: 'open',
  priority: 'high',
  channel: 'portal',
  category: { id: 'delivery', name: 'Delivery' },
  assignee: null,
  customer: {
    id: 'customer-1',
    name: 'Rhea Kapoor',
    email: 'rhea@example.test',
    phone: null,
    caseCount: 2,
  },
  thread: [
    {
      id: 'message-1',
      visibility: 'public',
      direction: 'inbound',
      author: 'Rhea Kapoor',
      body: 'The handle has a <script>alert(1)</script> crack.',
      createdAt: '2026-07-17T04:20:00.000Z',
      delivery: null,
      attachments: [
        {
          id: 'attachment-1',
          filename: 'damage.jpg',
          contentType: 'image/jpeg',
          size: 42117,
          resourceUri: 'able://attachments/attachment-1',
        },
      ],
    },
  ],
  attachments: [],
  deliveryWarnings: [],
  kbSuggestions: [],
  openedAt: '2026-07-17T04:20:00.000Z',
  updatedAt: '2026-07-17T04:20:00.000Z',
}

function mockHelpdesk(overrides: Partial<Helpdesk> = {}): Helpdesk {
  return {
    work: vi.fn(async () => ({ kind: 'queue', cases: [] })),
    act: vi.fn(async () => ({
      operationId: 'operation-1',
      replayed: false,
      case: workspace,
      delivery: 'queued',
    })),
    intake: vi.fn(async () => ({
      caseRef: 'MD-42' as CaseRef,
      created: true,
      publicUrl: 'https://support.example.test/requests/access#private-capability',
      delivery: 'queued',
    })),
    customer: vi.fn(async () => ({ case: workspace, accepted: true, delivery: null })),
    resource: vi.fn(async () => ({ contentType: 'text/plain', body: '' })),
    ...overrides,
  }
}

const knowledge: PublicKnowledge = {
  home: vi.fn(async () => ({
    sections: [{ id: 'getting-started', slug: 'first-steps', name: 'Getting started', description: 'First steps.' }],
    articles: [{ slug: 'care-guide', title: 'Care guide', excerpt: 'Keep it working well.', section: 'Getting started' }],
  })),
  search: vi.fn(async (query) => query ? [{ slug: 'care-guide', title: 'Care guide', excerpt: 'Keep it working well.', section: 'Getting started' }] : []),
  article: vi.fn(async (slug) => slug === 'care-guide' ? {
    slug,
    title: 'Care guide',
    excerpt: 'Keep it working well.',
    section: 'Getting started',
    bodyMarkdown: '# Before you begin\n\nDisconnect power and read the manual.',
    updatedAt: '2026-07-11T09:00:00.000Z',
  } : null),
}

function portal(
  helpdesk = mockHelpdesk(),
  customSettings = settings,
  voiceEnabled = false,
  ordersEnabled = false,
) {
  const root = new Hono()
  root.route('/', createPortalRoutes({
    helpdesk,
    settings: customSettings,
    knowledge,
    categories: [{ id: 'delivery', name: 'Delivery', description: 'Shipping and arrival issues.' }],
    verifyPublicWrite: vi.fn(async () => ({ ok: true })),
    storeAttachments: vi.fn(async () => ({ attachments: [], createdStorageKeys: [] })),
    cleanupAttachments: vi.fn(async () => undefined),
    customerResource: vi.fn(async () => ({ contentType: 'text/plain', body: 'attachment' })),
    voiceEnabled,
    ordersEnabled,
  }))
  return { root, helpdesk }
}

describe('customer portal', () => {
  it('renders a branded, useful home without customer-specific assumptions', async () => {
    const { root } = portal()
    const response = await root.request('https://support.example.test/')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('Able Desk')
    expect(html).toContain('Support that keeps its word.')
    expect(html).toContain('Search the knowledge base')
    expect(html).toContain('Care guide')
    expect(html).toContain('Open a request')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
  })

  it('links verified voice support from the portal only when it is enabled', async () => {
    const disabledHtml = await (await portal().root.request('https://support.example.test/')).text()
    const enabledHtml = await (await portal(mockHelpdesk(), settings, true).root.request('https://support.example.test/')).text()
    const ordersHtml = await (await portal(mockHelpdesk(), settings, true, true).root.request('https://support.example.test/')).text()

    expect(disabledHtml).not.toContain('class="floating-support" href="/"')
    expect(enabledHtml).toContain('class="floating-support" href="/"')
    expect(enabledHtml).toContain('Chat with support')
    expect(enabledHtml).not.toContain('order lookups')
    expect(ordersHtml).toContain('order lookups')
    expect(enabledHtml).toContain('class="floating-support"')
    expect(disabledHtml).not.toContain('class="floating-support"')
  })

  it('never appends a duplicate Support to the home title', async () => {
    const plain = await (await portal().root.request('https://support.example.test/')).text()
    const suffixed = await (await portal(mockHelpdesk(), { ...settings, displayName: 'Example Company Support' }).root.request('https://support.example.test/')).text()

    expect(plain).toContain('<title>Able Desk Support</title>')
    expect(suffixed).toContain('<title>Example Company Support</title>')
    expect(suffixed).not.toContain('Support Support')
  })

  it('renders a search-first branded home with favicon and topic browsing', async () => {
    const brandedSettings: WorkspaceSettingsView = {
      ...settings,
      displayName: 'Example Company',
      portalTitle: 'How can we help?',
      logoUrl: 'https://cdn.example.test/support-mark.svg',
      faviconUrl: 'https://cdn.example.test/favicon.png',
      accentColor: '#a64a5d',
      canvasColor: '#fffaf2',
      inkColor: '#1d1d1b',
      fontFamily: 'humanist',
    }
    const { root } = portal(mockHelpdesk(), brandedSettings)

    const home = await root.request('https://support.example.test/')
    const html = await home.text()
    const themeResponse = await root.request('https://support.example.test/workspace-theme.css')
    const theme = await themeResponse.text()

    expect(home.status).toBe(200)
    expect(html).toContain('<link rel="icon" href="https://cdn.example.test/favicon.png"')
    expect(html).toContain('src="https://cdn.example.test/support-mark.svg"')
    expect(html).toContain('Browse by topic')
    expect(html).toContain('Getting started')
    expect(html).toContain('Care guide')
    expect(html).toContain('/kb?section=first-steps')
    expect(html.indexOf('Search the knowledge base')).toBeLessThan(html.indexOf('Browse by topic'))
    expect(theme).toContain('--accent:#a64a5d')
    expect(theme).toContain('--canvas:#fffaf2')
    expect(theme).toContain('Optima')
    expect(themeResponse.headers.get('cache-control')).toBe('no-store')

    const topic = await root.request('https://support.example.test/kb?section=first-steps')
    expect(await topic.text()).toContain('Care guide')
  })

  it('fails closed when public intake is not ready', async () => {
    const helpdesk = mockHelpdesk()
    const { root } = portal(helpdesk, { ...settings, publicIntakeEnabled: false })
    const response = await root.request('https://support.example.test/requests', {
      method: 'POST',
      body: new URLSearchParams({
        request_id: 'request-1',
        name: 'Rhea Kapoor',
        email: 'rhea@example.test',
        subject: 'Help',
        body: 'Please help with this order.',
      }),
    })

    expect(response.status).toBe(503)
    expect(await response.text()).toContain('New requests are temporarily paused')
    expect(helpdesk.intake).not.toHaveBeenCalled()
  })

  it('opens a case only after the public-write guard succeeds', async () => {
    const helpdesk = mockHelpdesk()
    const guard = vi.fn(async () => ({ ok: true as const }))
    const root = new Hono()
    root.route('/', createPortalRoutes({
      helpdesk,
      settings,
      knowledge,
      categories: [],
      verifyPublicWrite: guard,
      storeAttachments: vi.fn(async () => ({ attachments: [], createdStorageKeys: [] })),
      cleanupAttachments: vi.fn(async () => undefined),
      customerResource: vi.fn(async () => ({ contentType: 'text/plain', body: 'attachment' })),
    }))
    const response = await root.request('https://support.example.test/requests', {
      method: 'POST',
      body: new URLSearchParams({
        request_id: 'request-91',
        name: 'Rhea Kapoor',
        email: 'rhea@example.test',
        subject: 'Cracked handle',
        body: 'The handle cracked during delivery.',
        'cf-turnstile-response': 'challenge-result',
      }),
    })

    expect(response.status).toBe(201)
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({
      action: 'intake',
      turnstileToken: 'challenge-result',
    }))
    expect(helpdesk.intake).toHaveBeenCalledWith(
      { kind: 'portal', requestId: 'request-91' },
      expect.objectContaining({ subject: 'Cracked handle', email: 'rhea@example.test' }),
    )
    const html = await response.text()
    expect(html).toContain('MD-42')
    expect(html).not.toContain('private-capability')
  })

  it('binds each Turnstile widget to the server-verified write action', async () => {
    const protectedSettings = { ...settings, turnstileSiteKey: '1x00000000000000000000AA' }
    const intake = portal(mockHelpdesk(), protectedSettings)
    expect(await (await intake.root.request('https://support.example.test/requests/new')).text())
      .toContain('data-action="intake"')
    expect(await (await intake.root.request('https://support.example.test/requests/recover')).text())
      .toContain('data-action="recover"')
    expect(await (await intake.root.request('https://support.example.test/requests/case', {
      headers: { cookie: '__Host-able_case=private-capability-token' },
    })).text())
      .toContain('data-action="reply"')
  })

  it('prefills the case reference when an email recovery link opens the recovery form', async () => {
    const { root } = portal(mockHelpdesk())
    const response = await root.request('https://support.example.test/requests/recover?ref=md-731')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('name="ref"')
    expect(html).toContain('value="MD-731"')
  })

  it('blocks recovery when the recovery notification is disabled', async () => {
    const { root } = portal(mockHelpdesk(), { ...settings, recoveryEmailEnabled: false })
    const page = await root.request('https://support.example.test/requests/recover')
    const html = await page.text()

    expect(html).toContain('Recovery email is temporarily paused')
    expect(html).toContain('disabled')
    expect(html).toContain('<button type="submit" disabled')

    const response = await root.request('https://support.example.test/requests/recover', {
      method: 'POST',
      body: new URLSearchParams(),
    })
    expect(response.status).toBe(503)
  })

  it('never confirms whether a recovery lookup matched', async () => {
    const helpdesk = mockHelpdesk({
      customer: vi.fn(async () => ({ case: null, accepted: false, delivery: null })),
    })
    const { root } = portal(helpdesk)
    const response = await root.request('https://support.example.test/requests/recover', {
      method: 'POST',
      body: new URLSearchParams({
        request_id: 'recover-1',
        email: 'private.person@example.test',
        ref: 'MD-9999',
      }),
    })
    const html = await response.text()

    expect(response.status).toBe(202)
    expect(html).toContain('If those details match')
    expect(html).not.toContain('private.person@example.test')
    expect(html).not.toContain('MD-9999')
  })

  it('exchanges a fragment-carried capability for a locked cookie before showing the thread', async () => {
    const helpdesk = mockHelpdesk()
    const { root } = portal(helpdesk)
    const access = await root.request('https://support.example.test/requests/access')
    const accessHtml = await access.text()

    expect(access.status).toBe(200)
    expect(accessHtml).toContain('/requests/capability-bootstrap.js')
    expect(accessHtml).not.toContain('super-secret-capability')
    expect(access.headers.get('content-security-policy')).toContain("script-src 'self'")

    const exchange = await root.request('https://support.example.test/requests/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://support.example.test',
        'x-able-capability-exchange': '1',
      },
      body: JSON.stringify({ capability: 'super-secret-capability' }),
    })
    const setCookie = exchange.headers.get('set-cookie') ?? ''
    expect(exchange.status).toBe(204)
    expect(setCookie).toContain('__Host-able_case=super-secret-capability')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Strict')

    const cookie = setCookie.split(';', 1)[0]!
    const response = await root.request('https://support.example.test/requests/case', {
      headers: { cookie },
    })
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(helpdesk.customer).toHaveBeenNthCalledWith(
      1,
      { token: 'super-secret-capability' },
      { kind: 'view' },
    )
    expect(helpdesk.customer).toHaveBeenNthCalledWith(
      2,
      { token: 'super-secret-capability' },
      { kind: 'view' },
    )
    expect(html).toContain('Shipment arrived with a cracked handle')
    expect(html).toContain('damage.jpg')
    expect(html).toContain('/requests/attachments/attachment-1')
    expect(html).not.toContain('super-secret-capability')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('rejects capability exchange that is not a same-origin JSON fetch', async () => {
    const helpdesk = mockHelpdesk()
    const { root } = portal(helpdesk)
    const response = await root.request('https://support.example.test/requests/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ capability: 'super-secret-capability' }),
    })

    expect(response.status).toBe(400)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(helpdesk.customer).not.toHaveBeenCalled()
  })

  it('does not retain the legacy capability-in-path route', async () => {
    const helpdesk = mockHelpdesk()
    const { root } = portal(helpdesk)
    const response = await root.request('https://support.example.test/requests/super-secret-capability')

    expect(response.status).toBe(404)
    expect(helpdesk.customer).not.toHaveBeenCalled()
  })

  it('authorizes an attachment through the locked cookie on a fixed route', async () => {
    const helpdesk = mockHelpdesk()
    const customerResource = vi.fn(async () => ({
      contentType: 'image/jpeg',
      body: 'private-binary',
      filename: 'damage.jpg',
    }))
    const root = new Hono()
    root.route('/', createPortalRoutes({
      helpdesk,
      settings,
      knowledge,
      categories: [],
      verifyPublicWrite: vi.fn(async () => ({ ok: true })),
      storeAttachments: vi.fn(async () => ({ attachments: [], createdStorageKeys: [] })),
      cleanupAttachments: vi.fn(async () => undefined),
      customerResource,
    }))
    const response = await root.request('https://support.example.test/requests/attachments/attachment-1', {
      headers: { cookie: '__Host-able_case=super-secret-capability' },
    })

    expect(response.status).toBe(200)
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('private-binary')
    expect(customerResource).toHaveBeenCalledWith(
      { token: 'super-secret-capability' },
      'able://attachments/attachment-1',
    )
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('submits customer replies on the fixed case route with the locked cookie', async () => {
    const helpdesk = mockHelpdesk()
    const { root } = portal(helpdesk)
    const response = await root.request('https://support.example.test/requests/case', {
      method: 'POST',
      headers: { cookie: '__Host-able_case=super-secret-capability' },
      body: new URLSearchParams({
        request_id: 'customer-reply-fixed-route-001',
        body: 'Here is the next diagnostic detail.',
      }),
    })

    expect(response.status).toBe(202)
    expect(helpdesk.customer).toHaveBeenCalledWith(
      { token: 'super-secret-capability' },
      {
        kind: 'reply',
        requestId: 'customer-reply-fixed-route-001',
        body: 'Here is the next diagnostic detail.',
      },
    )
  })

  it('preserves old portal entry points with permanent redirects', async () => {
    const { root } = portal()
    const response = await root.request('https://support.example.test/portal/en/newticket')

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/requests/new')
  })

  it('cleans up newly staged uploads when intake fails', async () => {
    const helpdesk = mockHelpdesk({ intake: vi.fn(async () => { throw new Error('intake failed') }) })
    const cleanupAttachments = vi.fn(async () => undefined)
    const root = new Hono()
    root.route('/', createPortalRoutes({
      helpdesk,
      settings,
      knowledge,
      categories: [],
      verifyPublicWrite: vi.fn(async () => ({ ok: true })),
      storeAttachments: vi.fn(async (_files, requestId) => ({
        attachments: [{
          id: `att_${requestId}`,
          filename: 'diagnostic.txt',
          contentType: 'text/plain',
          size: 4,
          storageKey: 'portal/staged/new-object',
          sha256: 'a'.repeat(64),
        }],
        createdStorageKeys: ['portal/staged/new-object'],
      })),
      cleanupAttachments,
      customerResource: vi.fn(async () => ({ contentType: 'text/plain', body: '' })),
    }))
    const form = new FormData()
    form.set('request_id', 'request-upload-failure-001')
    form.set('name', 'Rhea Kapoor')
    form.set('email', 'rhea@example.test')
    form.set('subject', 'Failed upload intake')
    form.set('body', 'This intake fails after file staging.')
    form.set('attachments', new File(['test'], 'diagnostic.txt', { type: 'text/plain' }))

    const response = await root.request('https://support.example.test/requests', { method: 'POST', body: form })

    expect(response.status).toBe(500)
    expect(cleanupAttachments).toHaveBeenCalledWith(['portal/staged/new-object'])
  })
})

describe('portal attachment staging', () => {
  it('reuses deterministic metadata and R2 keys for an exact form replay', async () => {
    const file = new File(['repeatable bytes'], '../diagnostic\n.txt', { type: 'text/plain' })
    const first = await storePortalFiles(env.ATTACHMENTS, [file], 'request-upload-replay-001')
    const replay = await storePortalFiles(env.ATTACHMENTS, [file], 'request-upload-replay-001')

    expect(replay.attachments).toEqual(first.attachments)
    expect(first.createdStorageKeys).toEqual([first.attachments[0]!.storageKey])
    expect(replay.createdStorageKeys).toEqual([])
    expect(first.attachments[0]!.filename).toBe('..-diagnostic-.txt')
    expect((await env.ATTACHMENTS.list()).objects).toHaveLength(1)

    await cleanupPortalFiles(env.DB, env.ATTACHMENTS, first.createdStorageKeys)
    expect(await env.ATTACHMENTS.head(first.attachments[0]!.storageKey)).toBeNull()
  })

  it('never deletes a staged object once canonical metadata committed', async () => {
    const batch = await storePortalFiles(
      env.ATTACHMENTS,
      [new File(['committed bytes'], 'evidence.txt', { type: 'text/plain' })],
      'request-upload-committed-001',
    )
    const attachment = batch.attachments[0]!
    await env.DB.prepare(
      `INSERT INTO stored_files
       (id, storage_key, filename, content_type, size, sha256)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      attachment.id,
      attachment.storageKey,
      attachment.filename,
      attachment.contentType,
      attachment.size,
      attachment.sha256,
    ).run()

    await cleanupPortalFiles(env.DB, env.ATTACHMENTS, batch.createdStorageKeys)

    expect(await env.ATTACHMENTS.head(attachment.storageKey)).not.toBeNull()
  })
})

describe('operator recovery console', () => {
  it('shows active channel conversations and their evidence without browser mutation controls', async () => {
    const communications = createCommunications({ db: env.DB })
    const receipt = await communications.ingest({
      channel: 'whatsapp',
      provider: 'meta_whatsapp',
      providerEventId: 'wamid.ops-recovery',
      providerMessageId: 'wamid.ops-recovery',
      accountId: 'test-waba',
      endpointId: 'test-phone-number',
      externalThreadId: '15550003000',
      occurredAt: '2026-07-20T14:08:42.000Z',
      payloadHash: 'a'.repeat(64),
    }, {
      contact: { name: 'Aarav Mehta', address: { kind: 'phone', value: '+15550003000' } },
      body: 'I need a quote for <five> routers.',
    })
    const root = new Hono()
    root.route('/ops', createOpsRoutes({
      helpdesk: mockHelpdesk(),
      communications,
      actor: operator,
      settings,
      diagnostics: vi.fn(async () => ({
        setup: { accessReady: true, securityReady: true, emailReady: true, intakeEnabled: true, lastEmailTestAt: '2026-07-17T03:00:00.000Z' },
        outbox: [],
        operators: [],
      })),
      verifyOperatorWrite: vi.fn(async () => true),
    }))

    const list = await root.request('https://support.example.test/ops/conversations')
    const listHtml = await list.text()
    expect(list.status).toBe(200)
    expect(listHtml).toContain('aria-current="page" href="/ops/conversations">Inbox</a>')
    expect(listHtml).toContain('Aarav Mehta')
    expect(listHtml).toContain('I need a quote for &lt;five&gt; routers.')
    expect(listHtml).toContain('Unclassified')

    const detail = await root.request(`https://support.example.test/ops/conversations/${receipt.conversation.id}`)
    const detailHtml = await detail.text()
    expect(detail.status).toBe(200)
    expect(detailHtml).toContain('Read-only recovery view')
    expect(detailHtml).toContain('No Desk case or CRM lead has been created.')
    expect(detailHtml).toContain(receipt.conversation.revision)
    expect(detailHtml).not.toContain('<form')
  })

  it('uses the verified actor and latest revision for an emergency reply', async () => {
    const helpdesk = mockHelpdesk({ work: vi.fn(async () => workspace) })
    const diagnostics: OpsDiagnostics = {
      setup: { accessReady: true, securityReady: true, emailReady: true, intakeEnabled: true, lastEmailTestAt: '2026-07-17T03:00:00.000Z' },
      outbox: [],
      operators: [{ id: operator.id, name: operator.name, email: operator.email, role: operator.role, active: true }],
    }
    const root = new Hono()
    root.route('/ops', createOpsRoutes({
      helpdesk,
      actor: operator,
      settings,
      diagnostics: vi.fn(async () => diagnostics),
      verifyOperatorWrite: vi.fn(async () => true),
    }))
    const response = await root.request('https://support.example.test/ops/cases/MD-42/reply', {
      method: 'POST',
      headers: { origin: 'https://support.example.test' },
      body: new URLSearchParams({ revision: 'rev-7', body: 'We are sending a replacement today.' }),
    })

    expect(response.status).toBe(303)
    expect(helpdesk.act).toHaveBeenCalledWith(operator, {
      kind: 'reply',
      ref: 'MD-42',
      revision: 'rev-7',
      body: 'We are sending a replacement today.',
    })
    expect(response.headers.get('location')).toContain('/ops/cases/MD-42')
  })

  it('plays a customer video inline from the protected case view', async () => {
    const videoWorkspace: CaseWorkspace = {
      ...workspace,
      thread: [{
        ...workspace.thread[0]!,
        attachments: [{
          id: 'attachment-video',
          filename: 'setup-cycle.mp4',
          contentType: 'video/mp4',
          size: 9_865_008,
          resourceUri: 'able://attachments/attachment-video',
        }],
      }],
    }
    const resource = vi.fn(async () => ({
      contentType: 'video/mp4',
      filename: 'setup-cycle.mp4',
      body: 'video-bytes',
    }))
    const helpdesk = mockHelpdesk({ work: vi.fn(async () => videoWorkspace), resource })
    const root = new Hono()
    root.route('/ops', createOpsRoutes({
      helpdesk,
      actor: operator,
      settings,
      diagnostics: vi.fn(async () => ({
        setup: { accessReady: true, securityReady: true, emailReady: true, intakeEnabled: true, lastEmailTestAt: '2026-07-17T03:00:00.000Z' },
        outbox: [],
        operators: [],
      })),
      verifyOperatorWrite: vi.fn(async () => true),
    }))

    const page = await root.request('https://operators.example.test/ops/cases/MD-42')
    const html = await page.text()
    const video = await root.request('https://operators.example.test/ops/video?uri=able%3A%2F%2Fattachments%2Fattachment-video')

    expect(page.status).toBe(200)
    expect(html).toContain('<video controls')
    expect(html).toContain('/ops/video?uri=able%3A%2F%2Fattachments%2Fattachment-video')
    expect(page.headers.get('content-security-policy')).toContain("media-src 'self'")
    expect(video.status).toBe(200)
    expect(video.headers.get('content-type')).toBe('video/mp4')
    expect(video.headers.get('content-disposition')).toBe('inline; filename="setup-cycle.mp4"')
    expect(new TextDecoder().decode(await video.arrayBuffer())).toBe('video-bytes')
    expect(resource).toHaveBeenCalledWith(operator, 'able://attachments/attachment-video')
  })

  it('queues the outbound setup test with the verified admin actor', async () => {
    const helpdesk = mockHelpdesk()
    const queueEmailTest = vi.fn(async () => undefined)
    const root = new Hono()
    root.route('/ops', createOpsRoutes({
      helpdesk,
      actor: operator,
      settings,
      diagnostics: vi.fn(async () => ({
        setup: { accessReady: true, securityReady: false, emailReady: false, intakeEnabled: false, lastEmailTestAt: null },
        outbox: [],
        operators: [],
      })),
      verifyOperatorWrite: vi.fn(async () => true),
      queueEmailTest,
    }))

    const response = await root.request('https://support.example.test/ops/settings/email-test', {
      method: 'POST',
      headers: { origin: 'https://support.example.test' },
      body: new URLSearchParams({ recipient: 'delivery-check@example.test' }),
    })

    expect(response.status).toBe(303)
    expect(queueEmailTest).toHaveBeenCalledWith(operator, 'delivery-check@example.test')
    expect(response.headers.get('location')).toBe('/ops/outbox')
  })

  it('lets an administrator save portal favicon and guarded brand settings manually', async () => {
    const updateSettings = vi.fn(async () => undefined)
    const brandedSettings: WorkspaceSettingsView = {
      ...settings,
      logoUrl: 'https://cdn.example.test/support-mark.svg',
      faviconUrl: 'https://cdn.example.test/favicon.png',
    }
    const root = new Hono()
    root.route('/ops', createOpsRoutes({
      helpdesk: mockHelpdesk(),
      actor: operator,
      settings: brandedSettings,
      diagnostics: vi.fn(async () => ({
        setup: { accessReady: true, securityReady: true, emailReady: true, intakeEnabled: true, lastEmailTestAt: '2026-07-17T03:00:00.000Z' },
        outbox: [],
        operators: [],
      })),
      verifyOperatorWrite: vi.fn(async () => true),
      updateSettings,
    }))

    const page = await root.request('https://support.example.test/ops/settings')
    expect(await page.text()).toContain('value="https://cdn.example.test/favicon.png"')

    const response = await root.request('https://support.example.test/ops/settings', {
      method: 'POST',
      headers: { origin: 'https://support.example.test' },
      body: new URLSearchParams({
        display_name: 'Example Company',
        portal_title: 'How can we help?',
        logo_url: 'https://cdn.example.test/support-mark.svg',
        favicon_url: 'https://cdn.example.test/favicon.png',
        home_url: 'https://example.test/',
        support_email: 'support@example.test',
        outbound_sender: 'help@example.test',
        portal_base_url: 'https://support.example.test',
        case_prefix: 'EX',
        locale: 'en',
        timezone: 'UTC',
        accent_color: '#a64a5d',
        canvas_color: '#fffaf2',
        ink_color: '#1d1d1b',
        font_family: 'humanist',
        public_intake_enabled: '1',
      }),
    })

    expect(response.status).toBe(303)
    expect(updateSettings).toHaveBeenCalledWith(operator, expect.objectContaining({
      displayName: 'Example Company',
      faviconUrl: 'https://cdn.example.test/favicon.png',
      accentColor: '#a64a5d',
      fontFamily: 'humanist',
    }))
  })
})

describe('help-centre search endpoints', () => {
  function searchPortal(voiceEnabled = false) {
    const root = new Hono()
    root.route('/', createPortalRoutes({
      helpdesk: mockHelpdesk(),
      settings,
      knowledge,
      categories: [],
      verifyPublicWrite: vi.fn(async () => ({ ok: true as const })),
      storeAttachments: vi.fn(async () => ({ attachments: [], createdStorageKeys: [] })),
      cleanupAttachments: vi.fn(async () => undefined),
      customerResource: vi.fn(async () => ({ contentType: 'text/plain', body: 'attachment' })),
      voiceEnabled,
    }))
    return root
  }

  it('serves instant search results as JSON with portal article links', async () => {
    const root = searchPortal()
    const response = await root.request('https://support.example.test/kb/search.json?q=care')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const data = await response.json() as { results: Array<Record<string, unknown>> }
    expect(data.results[0]).toMatchObject({
      slug: 'care-guide',
      title: 'Care guide',
      section: 'Getting started',
      url: '/kb/care-guide',
    })

    const empty = await root.request('https://support.example.test/kb/search.json')
    expect(await empty.json()).toEqual({ results: [] })
  })

  it('keeps knowledge search ordinary regardless of voice availability', async () => {
    const plainHtml = await (await searchPortal().request('https://support.example.test/')).text()
    expect(plainHtml).toContain('data-search-enhance')
    expect(plainHtml).not.toContain('data-chat')
    expect(plainHtml).toContain('Search help articles')

    const chatHtml = await (await searchPortal(true).request('https://support.example.test/')).text()
    expect(chatHtml).not.toContain('data-chat')
    expect(chatHtml).toContain('Search help articles')
  })

  it('no longer exposes the retired stateless /kb/ask endpoint', async () => {
    const response = await searchPortal(true).request('https://support.example.test/kb/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://support.example.test' },
      body: JSON.stringify({ question: 'How do I clean?' }),
    })
    expect(response.status).toBe(404)
  })
})
