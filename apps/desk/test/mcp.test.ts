import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { AccessError, authenticateAccess } from '../src/access'
import { createMcpHandler } from '../src/adapters/mcp/server'
import type { Crm } from '../src/crm'
import type { ImprovementControl } from '../src/improvement'
import type {
  ActionCommand,
  ActionReceipt,
  Actor,
  AttachmentInspection,
  CaseRef,
  CaseRevision,
  CaseWorkspace,
  CustomerCapability,
  CustomerCommand,
  CustomerReceipt,
  CustomerResult,
  Helpdesk,
  IntakeRequest,
  IntakeSource,
  ResourceBody,
  SearchResult,
  WorkSelector,
  QueueResult,
} from '../src/domain/types'
import type { Env } from '../src/env'
import type { OperationLoop } from '../src/operations'
import type { CustomerWorkspaceService } from '../src/suite/customer-workspace'

const workerEnv = env as unknown as Env

const owner: Actor = {
  id: 'operator-owner',
  email: 'owner@example.com',
  name: 'Owner',
  role: 'admin',
}

const agent: Actor = {
  id: 'operator-agent',
  email: 'agent@example.com',
  name: 'Agent',
  role: 'agent',
}

const workspace: CaseWorkspace = {
  kind: 'case',
  ref: 'MD-42' as CaseRef,
  revision: 'revision-7' as CaseRevision,
  subject: 'The machine stops during warm-up',
  status: 'open',
  priority: 'high',
  channel: 'email',
  category: { id: 'technical', name: 'Technical' },
  assignee: null,
  customer: {
    id: 'customer-1',
    name: 'Alex',
    email: 'alex@example.net',
    phone: null,
    caseCount: 2,
  },
  thread: [
    {
      id: 'message-1',
      visibility: 'public',
      direction: 'inbound',
      author: 'Alex',
      body: 'The display goes blank after a minute.',
      createdAt: '2026-07-17T03:00:00.000Z',
      delivery: null,
      attachments: [],
    },
  ],
  attachments: [],
  deliveryWarnings: [],
  kbSuggestions: [
    {
      slug: 'safe-startup',
      title: 'Safe startup checklist',
      excerpt: 'A short checklist for the first power-on.',
      resourceUri: 'able://articles/safe-startup',
    },
  ],
  openedAt: '2026-07-17T03:00:00.000Z',
  updatedAt: '2026-07-17T03:10:00.000Z',
}

class FakeHelpdesk implements Helpdesk {
  workCalls: Array<{ actor: Actor; selector: WorkSelector }> = []
  actCalls: Array<{ actor: Actor; command: ActionCommand }> = []
  resourceCalls: Array<{ actor: Actor; uri: string }> = []
  inspectionCalls: Array<{ actor: Actor; attachmentId: string }> = []

  async work(actor: Actor, selector: WorkSelector): Promise<CaseWorkspace | QueueResult | SearchResult> {
    this.workCalls.push({ actor, selector })
    if (selector.kind === 'knowledge') {
      return {
        kind: 'search',
        scope: 'knowledge',
        cases: [],
        articles: [{
          slug: 'safe-startup',
          title: 'Safe startup checklist',
          excerpt: 'A short checklist for the first power-on.',
          resourceUri: 'able://articles/safe-startup',
          section: { id: 'getting-started', name: 'Getting started' },
          published: true,
          revision: 'article-revision-1',
          updatedAt: '2026-07-17T03:00:00.000Z',
        }],
      }
    }
    return {
      ...workspace,
      // Deliberately simulate a future accidental repository leak. The MCP
      // boundary must never serialize credentials to the model or the App.
      customerCapability: 'must-not-leave-the-server',
      accessToken: 'access-token-must-not-leave-the-server',
      apiKey: 'api-key-must-not-leave-the-server',
      password: 'password-must-not-leave-the-server',
      authorization: 'bearer-must-not-leave-the-server',
      cookie: 'cookie-must-not-leave-the-server',
      privateKey: 'private-key-must-not-leave-the-server',
    } as CaseWorkspace
  }

  async act(actor: Actor, command: ActionCommand): Promise<ActionReceipt> {
    this.actCalls.push({ actor, command })
    return {
      operationId: 'operation-1',
      replayed: false,
      case: { ...workspace, status: command.kind === 'reply' ? 'waiting_on_customer' : workspace.status },
      delivery: command.kind === 'reply' ? 'accepted' : null,
    }
  }

  async intake(_source: IntakeSource, _request: IntakeRequest): Promise<CustomerReceipt> {
    throw new Error('not used by the MCP adapter')
  }

  async customer(_capability: CustomerCapability, _command: CustomerCommand): Promise<CustomerResult> {
    throw new Error('not used by the MCP adapter')
  }

  async inspectAttachment(actor: Actor, attachmentId: string): Promise<AttachmentInspection> {
    this.inspectionCalls.push({ actor, attachmentId })
    return {
      kind: 'attachment_inspection',
      caseRef: workspace.ref,
      attachment: {
        id: attachmentId,
        filename: 'leak.heic',
        contentType: 'image/heic',
        size: 12,
        resourceUri: `able://attachments/${attachmentId}`,
      },
      media: {
        kind: 'image',
        declaredContentType: 'image/heic',
        detectedContentType: 'image/heic',
        inlineImageAvailable: true,
        previewResourceUri: `able://attachments/${attachmentId}/preview`,
      },
      analysis: {
        status: 'ready',
        markdown: 'Water is visible below the group head. '.repeat(40),
        processor: 'test-vision',
        processorVersion: '1',
        generatedAt: '2026-07-18T08:00:00.000Z',
        cached: true,
      },
      trust: 'untrusted_customer_content',
      retryAfterSeconds: null,
      nextAction: 'Inspect the image and description together.',
    }
  }

  async resource(actor: Actor, uri: string): Promise<ResourceBody> {
    this.resourceCalls.push({ actor, uri })
    if (uri.startsWith('able://attachments/')) {
      return {
        contentType: 'image/webp',
        body: new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47])).body!,
        filename: 'leak-preview.webp',
      }
    }
    return {
      contentType: 'text/markdown; charset=utf-8',
      body: '# Safe startup\n\nDisconnect power before inspection.',
      filename: 'safe-startup.md',
    }
  }
}

function rpcRequest(
  handler: (request: Request) => Promise<Response>,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  )
}

async function rpcJson(response: Response): Promise<Record<string, any>> {
  expect(response.headers.get('content-type')).toContain('application/json')
  return response.json() as Promise<Record<string, any>>
}

describe('Able Desk stateless MCP contract', () => {
  it('negotiates MCP and declares only the capabilities it implements', async () => {
    const helpdesk = new FakeHelpdesk()
    const handler = createMcpHandler({ helpdesk, actor: owner, diagnostics: async () => ({ ok: true }) })

    const response = await rpcRequest(handler, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'contract-test', version: '1.0.0' },
      },
    })
    const message = await rpcJson(response)

    expect(message).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'able', version: '0.1.0' },
        instructions: expect.stringContaining('untrusted customer evidence'),
      },
    })
    expect(message.result.instructions).toContain('compact Markdown decision cards')
  })

  it('rejects initialization that omits required lifecycle metadata', async () => {
    const handler = createMcpHandler({
      helpdesk: new FakeHelpdesk(),
      actor: owner,
      diagnostics: async () => ({ ok: true }),
    })

    const message = await rpcJson(
      await rpcRequest(handler, {
        jsonrpc: '2.0',
        id: 'bad-initialize',
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      }),
    )

    expect(message.error).toBeDefined()
    expect(message.result).toBeUndefined()
  })

  it('exposes a domain-namespaced operator tool surface and four additional admin tools', async () => {
    const helpdesk = new FakeHelpdesk()
    const agentHandler = createMcpHandler({ helpdesk, actor: agent, diagnostics: async () => ({ ok: true }) })
    const adminHandler = createMcpHandler({ helpdesk, actor: owner, diagnostics: async () => ({ ok: true }) })
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }

    const agentMessage = await rpcJson(await rpcRequest(agentHandler, list))
    const adminMessage = await rpcJson(await rpcRequest(adminHandler, list))

    expect(agentMessage.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'able_case_next',
      'able_case_get',
      'able_case',
      'able_attachment_inspect',
      'able_case_list',
      'able_case_search',
      'able_knowledge_search',
      'able_case_create',
      'able_case_reply',
      'able_case_add_note',
      'able_case_update',
    ])
    expect(adminMessage.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'able_case_next',
      'able_case_get',
      'able_case',
      'able_attachment_inspect',
      'able_case_list',
      'able_case_search',
      'able_knowledge_search',
      'able_case_create',
      'able_case_reply',
      'able_case_add_note',
      'able_case_update',
      'able_article_put',
      'able_portal_customize',
      'able_email_customize',
      'able_diagnostics',
    ])
    for (const tool of adminMessage.result.tools) {
      expect(tool._meta).toMatchObject({
        ui: {
          resourceUri: 'ui://able/workspace.html',
          visibility: ['model'],
        },
        'ui/resourceUri': 'ui://able/workspace.html',
      })
    }
    const attachmentTool = agentMessage.result.tools.find((tool: { name: string }) => tool.name === 'able_attachment_inspect')
    expect(attachmentTool).toMatchObject({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        required: ['attachment_id'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        required: expect.arrayContaining(['schemaVersion', 'kind', 'attachment', 'media', 'analysis', 'trust']),
        additionalProperties: false,
      },
    })
    expect(JSON.stringify(adminMessage.result.tools)).not.toContain('actor')
  })

  it('lets an administrator inspect and patch guarded portal branding through MCP', async () => {
    const helpdesk = new FakeHelpdesk()
    const read = vi.fn(async () => ({
      schemaVersion: 'portal-customization.v1' as const,
      displayName: 'Able Desk',
      portalTitle: 'How can we help?',
      logoUrl: null,
      faviconUrl: null,
      homeUrl: null,
      accentColor: '#b54a28',
      canvasColor: '#f5f2ec',
      inkColor: '#191918',
      fontFamily: 'system' as const,
      customCssSupported: false as const,
    }))
    const update = vi.fn(async (patch: Record<string, unknown>) => ({
      ...await read(),
      ...patch,
    }))
    const handler = createMcpHandler({
      helpdesk,
      actor: owner,
      diagnostics: async () => ({ ok: true }),
      portalCustomization: { read, update },
    })

    const inspected = await rpcJson(await rpcRequest(handler, {
      jsonrpc: '2.0',
      id: 'portal-customization-read',
      method: 'tools/call',
      params: { name: 'able_portal_customize', arguments: {} },
    }))
    expect(JSON.parse(inspected.result.content[0].text)).toMatchObject({
      schemaVersion: 'portal-customization.v1',
      displayName: 'Able Desk',
      customCssSupported: false,
    })
    expect(update).not.toHaveBeenCalled()

    const changed = await rpcJson(await rpcRequest(handler, {
      jsonrpc: '2.0',
      id: 'portal-customization-update',
      method: 'tools/call',
      params: {
        name: 'able_portal_customize',
        arguments: {
          display_name: 'Example Company',
          portal_title: 'How can we help?',
          logo_url: 'https://cdn.example.test/support-mark.svg',
          favicon_url: 'https://cdn.example.test/favicon.png',
          accent_color: '#a64a5d',
          font_family: 'humanist',
        },
      },
    }))

    expect(changed.result.isError).toBe(false)
    expect(update).toHaveBeenCalledWith({
      displayName: 'Example Company',
      portalTitle: 'How can we help?',
      logoUrl: 'https://cdn.example.test/support-mark.svg',
      faviconUrl: 'https://cdn.example.test/favicon.png',
      accentColor: '#a64a5d',
      fontFamily: 'humanist',
    })
    expect(JSON.parse(changed.result.content[0].text)).toMatchObject({
      displayName: 'Example Company',
      faviconUrl: 'https://cdn.example.test/favicon.png',
    })
  })

  it('lets an administrator inspect, customize, and disable a customer email notification through MCP', async () => {
    const helpdesk = new FakeHelpdesk()
    const template = {
      notification: 'agent_reply' as const,
      label: 'Agent reply',
      enabled: true,
      subjectTemplate: 'Re: [{{case_ref}}] {{case_subject}}',
      bodyTextTemplate: 'Hi {{customer_name}},\n\n{{message_body}}\n\n{{case_link}}',
      bodyMarkdownTemplate: 'Hi {{customer_name}},\n\n{{message_body}}\n\n[View your private case]({{case_link}})',
      placeholders: ['customer_name', 'case_ref', 'case_subject', 'message_body', 'case_link', 'recovery_link', 'workspace_name'],
    }
    const read = vi.fn(async () => ({
      schemaVersion: 'email-customization.v1' as const,
      format: 'markdown' as const,
      templates: [template],
    }))
    const update = vi.fn(async (notification: string, patch: Record<string, unknown>) => ({
      ...await read(),
      templates: [{ ...template, ...patch, notification }],
    }))
    const handler = createMcpHandler({
      helpdesk,
      actor: owner,
      diagnostics: async () => ({ ok: true }),
      emailCustomization: { read, update },
    })

    const inspected = await rpcJson(await rpcRequest(handler, {
      jsonrpc: '2.0',
      id: 'email-customization-read',
      method: 'tools/call',
      params: { name: 'able_email_customize', arguments: {} },
    }))
    expect(JSON.parse(inspected.result.content[0].text)).toMatchObject({
      schemaVersion: 'email-customization.v1',
      format: 'markdown',
      templates: [expect.objectContaining({ notification: 'agent_reply', enabled: true })],
    })

    const changed = await rpcJson(await rpcRequest(handler, {
      jsonrpc: '2.0',
      id: 'email-customization-update',
      method: 'tools/call',
      params: {
        name: 'able_email_customize',
        arguments: {
          notification: 'agent_reply',
          enabled: false,
          subject_template: 'A reply on {{case_ref}}',
          body_markdown_template: 'Hello {{customer_name}},\n\n{{message_body}}',
        },
      },
    }))

    expect(changed.result.isError).toBe(false)
    expect(update).toHaveBeenCalledWith('agent_reply', {
      enabled: false,
      subjectTemplate: 'A reply on {{case_ref}}',
      bodyMarkdownTemplate: 'Hello {{customer_name}},\n\n{{message_body}}',
    })
  })

  it('exposes the Desk and CRM tracer as task-shaped tools', async () => {
    const helpdesk = new FakeHelpdesk()
    const workspaceCalls: Array<{ kind: string; value: unknown }> = []
    const crmCalls: unknown[] = []
    const customerWorkspace = {
      async load(_actor: Actor, ref: string) {
        workspaceCalls.push({ kind: 'load', value: ref })
        return { schemaVersion: 'customer-workspace.v1', kind: 'customer_workspace', subject: { caseRef: ref } }
      },
      async adoptHelpdeskCustomer(_actor: Actor, command: unknown) {
        workspaceCalls.push({ kind: 'adopt', value: command })
        return { receipt: { operationId: 'directory-operation' }, workspace: { schemaVersion: 'customer-workspace.v1' } }
      },
    } as unknown as CustomerWorkspaceService
    const crm = {
      async work() {
        throw new Error('not called through this adapter')
      },
      async salesLead(_actor: Actor, selector: unknown) {
        crmCalls.push({ kind: 'sales_lead_read', selector })
        return {
          kind: 'sales_lead',
          id: 'lead-1',
          partyId: 'party-1',
          title: 'Office equipment consultation',
          summary: 'Recommend an label printer and router for a growing studio.',
          status: 'new',
          owner: { id: owner.id, name: owner.name, email: owner.email },
          source: { module: 'channels', entityType: 'conversation', entityId: 'conversation-1' },
          revision: 'lead-revision-1',
          createdAt: '2026-07-18T13:00:00.000Z',
          updatedAt: '2026-07-18T13:00:00.000Z',
        }
      },
      async act(_actor: Actor, command: Record<string, unknown>) {
        crmCalls.push(command)
        if (command.kind === 'manage_relationship') return { operationId: 'relationship-operation', relationship: { id: 'relationship-1' } }
        if (command.kind === 'record_activity') return { operationId: 'activity-operation', activity: { id: 'activity-1' } }
        return { operationId: 'followup-operation', followUp: { id: 'followup-1' } }
      },
    } as unknown as Crm
    const handler = createMcpHandler({
      helpdesk,
      customerWorkspace,
      crm,
      actor: owner,
      diagnostics: async () => ({ ok: true }),
    })

    const listed = await rpcJson(await rpcRequest(handler, { jsonrpc: '2.0', id: 'suite-list', method: 'tools/list', params: {} }))
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'able_case_next',
      'able_case_get',
      'able_case',
      'able_attachment_inspect',
      'able_case_list',
      'able_case_search',
      'able_knowledge_search',
      'able_case_create',
      'able_case_reply',
      'able_case_add_note',
      'able_case_update',
      'able_crm_lead_next',
      'able_crm_lead',
      'able_customer_workspace',
      'able_party_adopt',
      'able_crm_relationship',
      'able_crm_activity',
      'able_crm_followup',
      'able_article_put',
      'able_portal_customize',
      'able_email_customize',
      'able_diagnostics',
    ])

    const call = async (id: string, name: string, arguments_: Record<string, unknown>) => rpcJson(await rpcRequest(handler, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: arguments_ },
    }))
    const nextLead = await call('lead-next', 'able_crm_lead_next', {})
    const readLead = await call('lead-read', 'able_crm_lead', { lead_id: 'lead-1' })
    expect(nextLead.result.isError).toBe(false)
    expect(readLead.result.isError).toBe(false)
    expect(nextLead.result.structuredContent).toMatchObject({
      kind: 'sales_lead',
      id: 'lead-1',
      title: 'Office equipment consultation',
      status: 'new',
      source: { module: 'channels', entityType: 'conversation', entityId: 'conversation-1' },
    })
    expect(nextLead.result.structuredContent).toEqual(JSON.parse(nextLead.result.content[0].text))
    for (const name of ['able_crm_lead_next', 'able_crm_lead']) {
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === name)?._meta).toMatchObject({
        ui: { resourceUri: 'ui://able/workspace.html', visibility: ['model'] },
        'ui/resourceUri': 'ui://able/workspace.html',
      })
    }
    expect((await call('workspace', 'able_customer_workspace', { ref: 'MD-42' })).result.isError).toBe(false)
    expect((await call('adopt', 'able_party_adopt', {
      ref: 'MD-42',
      revision: 'revision-7',
      intent_id: 'intent-adopt-42',
    })).result.isError).toBe(false)
    expect((await call('relationship', 'able_crm_relationship', {
      party_id: 'party-42',
      intent_id: 'intent-relationship-42',
      status: 'customer',
      owner_id: owner.id,
    })).result.isError).toBe(false)
    expect((await call('activity', 'able_crm_activity', {
      party_id: 'party-42',
      intent_id: 'intent-activity-42',
      revision: 'crm-revision-1',
      activity_kind: 'support',
      summary: 'Resolved the support question.',
      occurred_at: '2026-07-18T13:00:00.000Z',
      source_case_ref: 'MD-42',
    })).result.isError).toBe(false)
    expect((await call('followup', 'able_crm_followup', {
      party_id: 'party-42',
      intent_id: 'intent-followup-42',
      revision: 'crm-revision-2',
      subject: 'Confirm the outcome',
      due_at: '2026-07-20T09:00:00.000Z',
      owner_id: owner.id,
    })).result.isError).toBe(false)

    expect(workspaceCalls).toEqual([
      { kind: 'load', value: 'MD-42' },
      { kind: 'adopt', value: { ref: 'MD-42', revision: 'revision-7', intentId: 'intent-adopt-42' } },
    ])
    expect(crmCalls).toEqual([
      { kind: 'sales_lead_read', selector: { kind: 'next' } },
      { kind: 'sales_lead_read', selector: { kind: 'id', id: 'lead-1' } },
      { kind: 'manage_relationship', partyId: 'party-42', intentId: 'intent-relationship-42', status: 'customer', ownerId: owner.id },
      {
        kind: 'record_activity',
        partyId: 'party-42',
        intentId: 'intent-activity-42',
        revision: 'crm-revision-1',
        activityKind: 'support',
        summary: 'Resolved the support question.',
        occurredAt: '2026-07-18T13:00:00.000Z',
        source: { module: 'helpdesk', entityType: 'case', entityId: 'MD-42' },
      },
      {
        kind: 'schedule_followup',
        partyId: 'party-42',
        intentId: 'intent-followup-42',
        revision: 'crm-revision-2',
        subject: 'Confirm the outcome',
        dueAt: '2026-07-20T09:00:00.000Z',
        ownerId: owner.id,
      },
    ])
  })

  it('exposes an ergonomic conversation inbox with explicit read, route, clear, and reply actions', async () => {
    const calls: Array<{ kind: string; value: unknown }> = []
    const conversation = {
      kind: 'conversation' as const,
      id: 'conversation-1',
      revision: 'conversation-revision-1',
      channel: 'whatsapp' as const,
      contact: {
        channelContactId: 'contact-1',
        name: 'Inbox Customer',
        address: { kind: 'phone' as const, value: '+15550002000' },
        email: null,
        phone: '+15550002000',
      },
      replyCapability: {
        available: true,
        reason: null,
        nextAction: 'Use able_conversation_reply with the latest revision.',
      },
      attention: 'needs_attention' as const,
      resolution: null,
      messages: [{
        id: 'message-1', direction: 'inbound' as const, author: 'Inbox Customer', body: 'Can you help?',
        delivery: null, providerMessageId: 'wamid.inbox-1', occurredAt: '2026-07-21T03:00:00.000Z',
      }],
      routes: [],
      lastInboundAt: '2026-07-21T03:00:00.000Z',
      createdAt: '2026-07-21T03:00:00.000Z',
      updatedAt: '2026-07-21T03:00:00.000Z',
    }
    const communications = {
      async work(_actor: Actor, selector: unknown) {
        calls.push({ kind: 'work', value: selector })
        if ((selector as { kind?: string }).kind === 'queue') {
          return {
            kind: 'conversation_queue',
            conversations: [{
              id: conversation.id,
              channel: conversation.channel,
              contact: {
                name: conversation.contact.name,
                address: conversation.contact.address,
                email: conversation.contact.email,
                phone: conversation.contact.phone,
              },
              attention: conversation.attention,
              messageCount: 1,
              latestInboundBody: 'Can you help?',
              latestInboundTruncated: false,
              routeTargets: [],
              lastInboundAt: conversation.lastInboundAt,
            }],
            returned: 1,
            hasMore: false,
            nextCursor: null,
            nextAction: null,
          }
        }
        return conversation
      },
      async act(_actor: Actor, command: unknown) {
        calls.push({ kind: 'act', value: command })
        return { operationId: 'conversation-operation', replayed: false, conversation, delivery: 'queued' }
      },
    }
    const conversationRouter = {
      async route(_actor: Actor, command: unknown) {
        calls.push({ kind: 'route', value: command })
        return {
          kind: 'conversation_route',
          conversationId: 'conversation-1',
          completed: ['sales'],
          pending: [],
          pendingReasons: [],
          nextAction: null,
          links: [],
          conversation,
        }
      },
    }
    const handler = createMcpHandler({
      helpdesk: new FakeHelpdesk(),
      communications,
      conversationRouter,
      actor: owner,
      diagnostics: async () => ({ ok: true }),
    } as any)
    const listed = await rpcJson(await rpcRequest(handler, {
      jsonrpc: '2.0', id: 'conversation-list', method: 'tools/list', params: {},
    }))
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining([
      'able_inbox_next',
      'able_inbox_list',
      'able_conversation_get',
      'able_conversation_route',
      'able_conversation_classify',
      'able_conversation_reopen',
      'able_conversation_reply',
    ]))

    const call = async (id: string, name: string, arguments_: Record<string, unknown>) => rpcJson(await rpcRequest(handler, {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ },
    }))
    const next = await call('inbox-next', 'able_inbox_next', {})
    expect(next.result.isError, JSON.stringify(next.result)).toBe(false)
    expect(next.result.structuredContent).toMatchObject({
      schemaVersion: 'conversation-workspace.v2',
      id: 'conversation-1',
      messageWindow: { responseFormat: 'concise', total: 1, returned: 1, omitted: 0 },
    })
    expect((await call('inbox-list', 'able_inbox_list', { limit: 2 })).result.isError).toBe(false)
    expect((await call('conversation-get', 'able_conversation_get', {
      conversation_id: 'conversation-1', response_format: 'detailed',
    })).result.isError).toBe(false)
    expect((await call('conversation-route', 'able_conversation_route', {
      conversation_id: 'conversation-1',
      revision: 'conversation-revision-1',
      intent_id: 'route-sales-1',
      target: 'sales',
    })).result.isError).toBe(false)
    const classify = await call('conversation-classify', 'able_conversation_classify', {
      conversation_id: 'conversation-1',
      revision: 'conversation-revision-2',
      intent_id: 'clear-duplicate-1',
      disposition: 'duplicate',
      reason: 'The sender already has an open conversation for this request.',
    })
    expect(classify.result.isError).toBe(false)
    expect(classify.result.structuredContent).toMatchObject({
      schemaVersion: 'conversation-action.v2',
      operationId: 'conversation-operation',
      delivery: 'queued',
      conversation: { schemaVersion: 'conversation-workspace.v2', messageWindow: { returned: 1 } },
    })
    expect((await call('conversation-reopen', 'able_conversation_reopen', {
      conversation_id: 'conversation-1',
      revision: 'conversation-revision-2',
      intent_id: 'reopen-duplicate-1',
      reason: 'The inquiry needs a sales lead after all.',
    })).result.isError).toBe(false)
    expect((await call('conversation-reply', 'able_conversation_reply', {
      conversation_id: 'conversation-1',
      revision: 'conversation-revision-2',
      intent_id: 'reply-1',
      body: 'Thanks. We can help with that requirement.',
    })).result.isError).toBe(false)
    expect(calls).toEqual([
      { kind: 'work', value: { kind: 'next' } },
      { kind: 'work', value: { kind: 'queue', limit: 2 } },
      { kind: 'work', value: { kind: 'conversation', id: 'conversation-1' } },
      {
        kind: 'route',
        value: {
          conversationId: 'conversation-1',
          revision: 'conversation-revision-1',
          intentId: 'route-sales-1',
          target: 'sales',
        },
      },
      {
        kind: 'act',
        value: {
          kind: 'classify',
          conversationId: 'conversation-1',
          revision: 'conversation-revision-2',
          intentId: 'clear-duplicate-1',
          disposition: 'duplicate',
          reason: 'The sender already has an open conversation for this request.',
        },
      },
      {
        kind: 'act',
        value: {
          kind: 'reopen',
          conversationId: 'conversation-1',
          revision: 'conversation-revision-2',
          intentId: 'reopen-duplicate-1',
          reason: 'The inquiry needs a sales lead after all.',
        },
      },
      {
        kind: 'act',
        value: {
          kind: 'reply',
          conversationId: 'conversation-1',
          revision: 'conversation-revision-2',
          intentId: 'reply-1',
          body: 'Thanks. We can help with that requirement.',
        },
      },
    ])
  })

  it('holds the inbox decision workspace to bounded, paginated message windows', async () => {
    const messages = Array.from({ length: 61 }, (_, index) => ({
      id: `message-${index + 1}`,
      direction: 'inbound' as const,
      author: 'Long-thread customer',
      body: `Message ${index + 1}: ${'x'.repeat(3_000)}`,
      delivery: null,
      providerMessageId: `wamid.long-${index + 1}`,
      occurredAt: `2026-07-21T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    }))
    const conversation = {
      kind: 'conversation' as const,
      id: 'conversation-long',
      revision: 'conversation-long-revision',
      channel: 'whatsapp' as const,
      contact: {
        channelContactId: 'contact-long',
        name: 'Long-thread customer',
        address: { kind: 'phone' as const, value: '+15550002001' },
        email: null,
        phone: '+15550002001',
      },
      replyCapability: {
        available: true,
        reason: null,
        nextAction: 'Use able_conversation_reply with the latest revision.',
      },
      attention: 'needs_attention' as const,
      resolution: null,
      messages,
      routes: [],
      lastInboundAt: '2026-07-21T23:00:00.000Z',
      createdAt: '2026-07-21T01:00:00.000Z',
      updatedAt: '2026-07-21T23:00:00.000Z',
    }
    const handler = createMcpHandler({
      helpdesk: new FakeHelpdesk(),
      communications: {
        async work(_actor: Actor, selector: { kind: string }) {
          if (selector.kind === 'queue') return {
            kind: 'conversation_queue' as const,
            conversations: [{
              id: conversation.id,
              channel: conversation.channel,
              contact: {
                name: conversation.contact.name,
                address: conversation.contact.address,
                email: conversation.contact.email,
                phone: conversation.contact.phone,
              },
              attention: conversation.attention,
              messageCount: messages.length,
              latestInboundBody: messages.at(-1)!.body.slice(0, 1_000),
              latestInboundTruncated: true,
              routeTargets: [],
              lastInboundAt: conversation.lastInboundAt,
            }],
            returned: 1,
            hasMore: false,
            nextCursor: null,
            nextAction: null,
          }
          return conversation
        },
        async act() { throw new Error('Mutations are not part of this read-only evaluation fixture') },
      },
      conversationRouter: { async route() { throw new Error('Routing is not part of this read-only evaluation fixture') } },
      actor: owner,
      diagnostics: async () => ({ ok: true }),
    } as any)
    const call = async (id: string, name: string, arguments_: Record<string, unknown>) => rpcJson(await rpcRequest(handler, {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ },
    }))

    const newest = await call('long-newest', 'able_conversation_get', {
      conversation_id: conversation.id,
      response_format: 'detailed',
    })
    expect(newest.result.isError, JSON.stringify(newest.result)).toBe(false)
    expect(newest.result.structuredContent).toMatchObject({
      schemaVersion: 'conversation-workspace.v2',
      messageWindow: { responseFormat: 'detailed', page: 0, limit: 50, total: 61, returned: 50, omitted: 11 },
    })
    expect(newest.result.structuredContent.messages.every((message: { body: string; bodyTruncated: boolean }) =>
      message.body.length <= 1_000 && message.bodyTruncated,
    )).toBe(true)
    expect(JSON.stringify(newest.result.structuredContent).length).toBeLessThan(75_000)

    const expanded = await call('long-expanded', 'able_conversation_get', {
      conversation_id: conversation.id,
      message_id: 'message-61',
      message_offset: 1_000,
      message_body_limit: 2_000,
    })
    expect(expanded.result.structuredContent.messageContent).toMatchObject({
      messageId: 'message-61',
      offset: 1_000,
      limit: 2_000,
      returned: 2_000,
      omitted: expect.any(Number),
      nextAction: expect.stringContaining('message_offset 3000'),
    })
    expect(expanded.result.structuredContent.messageContent.body).toHaveLength(2_000)

    const older = await call('long-older', 'able_conversation_get', {
      conversation_id: conversation.id,
      response_format: 'detailed',
      message_page: 1,
    })
    expect(older.result.structuredContent.messageWindow).toMatchObject({
      page: 1,
      returned: 11,
      omitted: 50,
      nextAction: expect.stringContaining('message_id "message-1"'),
    })

    const queue = await call('long-queue', 'able_inbox_list', { limit: 1 })
    expect(queue.result.structuredContent.conversations[0]).toMatchObject({
      latestInboundTruncated: true,
      latestInboundBody: expect.stringMatching(/^Message 61:/),
    })
  })

  it('exposes typed operation closure and admin improvement controls', async () => {
    const operationCalls: Array<{ kind: string; value: unknown }> = []
    const improvementCalls: Array<{ kind: string; value: unknown }> = []
    const operations = {
      async work(_actor: Actor, operationId: string) {
        operationCalls.push({ kind: 'work', value: operationId })
        return { kind: 'operation_closure', operationId }
      },
      async track(_actor: Actor, command: unknown) {
        operationCalls.push({ kind: 'track', value: command })
        return { receiptId: 'track-receipt' }
      },
      async observe(_actor: Actor, command: unknown) {
        operationCalls.push({ kind: 'observe', value: command })
        return { receiptId: 'observe-receipt' }
      },
      async expire(_actor: Actor, command: unknown) {
        operationCalls.push({ kind: 'expire', value: command })
        return { receiptId: 'expire-receipt' }
      },
    } as unknown as OperationLoop
    const improvements = {
      async work(_actor: Actor, proposalId: string) {
        improvementCalls.push({ kind: 'work', value: proposalId })
        return { kind: 'improvement_proposal', id: proposalId }
      },
      async propose(_actor: Actor, command: unknown) {
        improvementCalls.push({ kind: 'propose', value: command })
        return { receiptId: 'proposal-receipt' }
      },
      async evaluate(_actor: Actor, command: unknown) {
        improvementCalls.push({ kind: 'evaluate', value: command })
        return { receiptId: 'evaluation-receipt' }
      },
    } as unknown as ImprovementControl
    const handler = createMcpHandler({
      helpdesk: new FakeHelpdesk(),
      operations,
      improvements,
      actor: owner,
      diagnostics: async () => ({ ok: true }),
    })
    const call = async (id: string, name: string, arguments_: Record<string, unknown>) => rpcJson(await rpcRequest(handler, {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ },
    }))
    const listed = await rpcJson(await rpcRequest(handler, { jsonrpc: '2.0', id: 'loop-list', method: 'tools/list', params: {} }))
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining([
      'able_operation',
      'able_operation_track',
      'able_operation_observe',
      'able_operation_expire',
      'able_improvement',
      'able_improvement_propose',
      'able_improvement_evaluate',
    ]))

    await call('operation-read', 'able_operation', { operation_id: 'op-target' })
    await call('operation-track', 'able_operation_track', {
      operation_id: 'op-target',
      intent_id: 'intent-track',
      contract_name: 'crm.followup-confirmed.v1',
      intended_effect: 'Confirm the promised customer follow-up happened.',
      authoritative_source: 'operator_confirmation',
      accepted_definition: 'The follow-up command was accepted.',
      delivered_definition: 'The follow-up reached the customer channel.',
      success_definition: 'The customer follow-up was confirmed.',
      failure_definition: 'The follow-up could not be completed.',
      indeterminate_definition: 'No authoritative confirmation is available.',
      recovery_policy: 'human_review',
      guard_metric: 'customer.opt_out_rate',
      not_before: '2026-07-18T15:00:00.000Z',
      expires_at: '2026-07-25T15:00:00.000Z',
    })
    await call('operation-observe', 'able_operation_observe', {
      operation_id: 'op-target',
      revision: 'closure-revision-1',
      intent_id: 'intent-observe',
      source: 'operator_confirmation',
      source_revision: 'confirmation-1',
      observed_at: '2026-07-20T09:00:00.000Z',
      result: 'succeeded',
      summary: 'The operator confirmed the follow-up outcome.',
    })
    await call('operation-expire', 'able_operation_expire', {
      operation_id: 'op-expiring',
      revision: 'closure-revision-expiring',
      intent_id: 'intent-expire',
    })
    await call('improvement-read', 'able_improvement', { proposal_id: 'proposal-1' })
    await call('improvement-propose', 'able_improvement_propose', {
      intent_id: 'intent-propose',
      scope: 'tenant',
      artifact_kind: 'playbook',
      target_key: 'crm.followup.confirmation',
      base_version: 'v1',
      candidate_version: 'v2',
      evidence_operation_id: 'op-target',
    })
    await call('improvement-evaluate', 'able_improvement_evaluate', {
      intent_id: 'intent-evaluate',
      proposal_id: 'proposal-1',
      revision: 'proposal-revision-1',
      suite_version: 'followup-evals.v1',
      passed: true,
      summary: 'Targeted and regression fixtures passed.',
    })

    expect(operationCalls).toEqual([
      { kind: 'work', value: 'op-target' },
      {
        kind: 'track',
        value: {
          operationId: 'op-target',
          intentId: 'intent-track',
          contract: {
            name: 'crm.followup-confirmed.v1',
            intendedEffect: 'Confirm the promised customer follow-up happened.',
            authoritativeSource: `operator:${owner.id}`,
            acceptedDefinition: 'The follow-up command was accepted.',
            deliveredDefinition: 'The follow-up reached the customer channel.',
            successDefinition: 'The customer follow-up was confirmed.',
            failureDefinition: 'The follow-up could not be completed.',
            indeterminateDefinition: 'No authoritative confirmation is available.',
            recoveryPolicy: 'human_review',
            guardMetrics: ['customer.opt_out_rate'],
            notBefore: '2026-07-18T15:00:00.000Z',
            expiresAt: '2026-07-25T15:00:00.000Z',
          },
        },
      },
      {
        kind: 'observe',
        value: {
          operationId: 'op-target',
          revision: 'closure-revision-1',
          intentId: 'intent-observe',
          source: `operator:${owner.id}`,
          sourceRevision: 'confirmation-1',
          observedAt: '2026-07-20T09:00:00.000Z',
          result: 'succeeded',
          summary: 'The operator confirmed the follow-up outcome.',
        },
      },
      {
        kind: 'expire',
        value: {
          operationId: 'op-expiring',
          revision: 'closure-revision-expiring',
          intentId: 'intent-expire',
        },
      },
    ])
    expect(improvementCalls).toEqual([
      { kind: 'work', value: 'proposal-1' },
      {
        kind: 'propose',
        value: {
          intentId: 'intent-propose',
          scope: 'tenant',
          artifactKind: 'playbook',
          targetKey: 'crm.followup.confirmation',
          baseVersion: 'v1',
          candidateVersion: 'v2',
          evidence: [{ kind: 'operation_receipt', id: 'op-target' }],
        },
      },
      {
        kind: 'evaluate',
        value: {
          intentId: 'intent-evaluate',
          proposalId: 'proposal-1',
          revision: 'proposal-revision-1',
          suiteVersion: 'followup-evals.v1',
          passed: true,
          report: { summary: 'Targeted and regression fixtures passed.', metrics: {} },
        },
      },
    ])
  })

  it('handles a normal case with able_case_next followed by able_case_reply', async () => {
    const helpdesk = new FakeHelpdesk()
    const handler = createMcpHandler({ helpdesk, actor: agent, diagnostics: async () => ({ ok: true }) })

    const nextMessage = await rpcJson(
      await rpcRequest(handler, {
        jsonrpc: '2.0',
        id: 'next',
        method: 'tools/call',
        params: { name: 'able_case_next', arguments: {} },
      }),
    )

    const nextPayload = JSON.parse(nextMessage.result.content[0].text)
    expect(nextPayload).toMatchObject({ ref: 'MD-42', revision: 'revision-7', subject: workspace.subject })
    expect(nextMessage.result.structuredContent).toEqual(nextPayload)
    expect(JSON.stringify(nextPayload)).not.toContain('must-not-leave-the-server')
    expect(JSON.stringify(nextMessage.result.structuredContent)).not.toContain('must-not-leave-the-server')
    expect(helpdesk.workCalls).toEqual([{ actor: agent, selector: { kind: 'next' } }])

    const replyMessage = await rpcJson(
      await rpcRequest(handler, {
        jsonrpc: '2.0',
        id: 'reply',
        method: 'tools/call',
        params: {
          name: 'able_case_reply',
          arguments: { ref: 'MD-42', revision: 'revision-7', body: 'Please try the startup checklist.' },
        },
      }),
    )

    expect(helpdesk.actCalls).toEqual([
      {
        actor: agent,
        command: {
          kind: 'reply',
          ref: 'MD-42',
          revision: 'revision-7',
          body: 'Please try the startup checklist.',
        },
      },
    ])
    expect(JSON.parse(replyMessage.result.content[0].text)).toMatchObject({
      operationId: 'operation-1',
      delivery: 'accepted',
      case: { status: 'waiting_on_customer' },
    })
    expect(replyMessage.result.structuredContent).toEqual(JSON.parse(replyMessage.result.content[0].text))
  })

  it('accepts standard MCP request metadata on tool calls', async () => {
    const helpdesk = new FakeHelpdesk()
    const handler = createMcpHandler({ helpdesk, actor: agent, diagnostics: async () => ({ ok: true }) })

    const message = await rpcJson(
      await rpcRequest(handler, {
        jsonrpc: '2.0',
        id: 'metadata-compatible-call',
        method: 'tools/call',
        params: {
          name: 'able_case_get',
          arguments: { ref: 'MD-42' },
          _meta: { progressToken: 'progress-1', 'example.dev/client': 'codex' },
        },
      }),
    )

    expect(message.error).toBeUndefined()
    expect(message.result.isError).toBe(false)
    expect(JSON.parse(message.result.content[0].text)).toMatchObject({ ref: 'MD-42' })
    expect(helpdesk.workCalls).toEqual([{ actor: agent, selector: { kind: 'case', ref: 'MD-42' } }])
  })

  it('adds an Access-protected browser URL to case and attachment evidence cards', async () => {
    const helpdesk = new FakeHelpdesk()
    const handler = createMcpHandler({
      helpdesk,
      actor: agent,
      diagnostics: async () => ({ ok: true }),
      operatorOrigin: 'https://operators.example.test',
    })

    const caseMessage = await rpcJson(await rpcRequest(handler, {
      jsonrpc: '2.0',
      id: 'case-browser-url',
      method: 'tools/call',
      params: { name: 'able_case', arguments: { ref: 'MD-42' } },
    }))
    const attachmentMessage = await rpcJson(await rpcRequest(handler, {
      jsonrpc: '2.0',
      id: 'attachment-browser-url',
      method: 'tools/call',
      params: { name: 'able_attachment_inspect', arguments: { attachment_id: 'att_image' } },
    }))

    const expected = 'https://operators.example.test/ops/cases/MD-42'
    expect(caseMessage.result.structuredContent.operatorCaseUrl).toBe(expected)
    expect(JSON.parse(caseMessage.result.content[0].text).operatorCaseUrl).toBe(expected)
    expect(attachmentMessage.result.structuredContent.operatorCaseUrl).toBe(expected)
  })

  it('progressively discloses cached attachment evidence and verified visual content', async () => {
    const helpdesk = new FakeHelpdesk()
    const handler = createMcpHandler({ helpdesk, actor: agent, diagnostics: async () => ({ ok: true }) })

    const summary = await rpcJson(await rpcRequest(handler, {
      jsonrpc: '2.0',
      id: 'attachment-summary',
      method: 'tools/call',
      params: {
        name: 'able_attachment_inspect',
        arguments: { attachment_id: 'att_image', detail: 'summary' },
      },
    }))
    expect(summary.result.isError).toBe(false)
    expect(summary.result.content).toHaveLength(1)
    expect(summary.result.structuredContent).toMatchObject({
      kind: 'attachment_inspection',
      caseRef: 'MD-42',
      detail: 'summary',
      trust: 'untrusted_customer_content',
      analysis: { status: 'ready', truncated: true },
    })
    expect(summary.result.structuredContent.analysis.markdown.length).toBeLessThanOrEqual(800)

    const visual = await rpcJson(await rpcRequest(handler, {
      jsonrpc: '2.0',
      id: 'attachment-visual',
      method: 'tools/call',
      params: {
        name: 'able_attachment_inspect',
        arguments: { attachment_id: 'att_image', detail: 'visual', focus: 'Where is the leak?' },
      },
    }))
    expect(visual.result.content).toEqual([
      expect.objectContaining({ type: 'text' }),
      { type: 'image', data: 'iVBORw==', mimeType: 'image/webp' },
    ])
    expect(visual.result.structuredContent).toMatchObject({
      detail: 'visual',
      requestedFocus: 'Where is the leak?',
    })
    expect(helpdesk.inspectionCalls).toEqual([
      { actor: agent, attachmentId: 'att_image' },
      { actor: agent, attachmentId: 'att_image' },
    ])
    expect(helpdesk.resourceCalls.at(-1)).toEqual({ actor: agent, uri: 'able://attachments/att_image/preview' })
  })

  it('searches knowledge through the Helpdesk work seam', async () => {
    const helpdesk = new FakeHelpdesk()
    const handler = createMcpHandler({ helpdesk, actor: agent, diagnostics: async () => ({ ok: true }) })

    const message = await rpcJson(
      await rpcRequest(handler, {
        jsonrpc: '2.0',
        id: 'knowledge-search',
        method: 'tools/call',
        params: {
          name: 'able_knowledge_search',
          arguments: { query: 'startup', limit: 3 },
        },
      }),
    )

    expect(helpdesk.workCalls).toEqual([
      { actor: agent, selector: { kind: 'knowledge', query: 'startup', limit: 3 } },
    ])
    expect(JSON.parse(message.result.content[0].text)).toMatchObject({
      kind: 'search',
      scope: 'knowledge',
      articles: [{ slug: 'safe-startup', revision: 'article-revision-1' }],
    })
  })

  it('passes customer corrections through able_case_update without allowing identity overrides', async () => {
    const helpdesk = new FakeHelpdesk()
    const handler = createMcpHandler({ helpdesk, actor: agent, diagnostics: async () => ({ ok: true }) })

    const message = await rpcJson(
      await rpcRequest(handler, {
        jsonrpc: '2.0',
        id: 'customer-correction',
        method: 'tools/call',
        params: {
          name: 'able_case_update',
          arguments: {
            ref: 'MD-42',
            revision: 'revision-7',
            customer_name: 'Alex Morgan',
            customer_email: 'ALEX.MORGAN@EXAMPLE.NET',
            customer_phone: null,
          },
        },
      }),
    )

    expect(message.result.isError).toBe(false)
    expect(helpdesk.actCalls).toEqual([{
      actor: agent,
      command: {
        kind: 'manage',
        ref: 'MD-42',
        revision: 'revision-7',
        customer: {
          name: 'Alex Morgan',
          email: 'alex.morgan@example.net',
          phone: null,
        },
      },
    }])
  })

  it('rejects tool-supplied actor identity before the Helpdesk seam', async () => {
    const helpdesk = new FakeHelpdesk()
    const handler = createMcpHandler({ helpdesk, actor: agent, diagnostics: async () => ({ ok: true }) })

    const message = await rpcJson(
      await rpcRequest(handler, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'able_case_reply',
          arguments: {
            ref: 'MD-42',
            revision: 'revision-7',
            body: 'Unsafe identity override attempt.',
            actor: { email: 'attacker@example.net', role: 'admin' },
          },
        },
      }),
    )

    expect(message.result.isError).toBe(true)
    expect(message.result.content[0].text).toContain('Unrecognized key')
    expect(helpdesk.actCalls).toHaveLength(0)
  })

  it('reads only the declared attachment and article resource families', async () => {
    const helpdesk = new FakeHelpdesk()
    const handler = createMcpHandler({ helpdesk, actor: agent, diagnostics: async () => ({ ok: true }) })

    const templates = await rpcJson(
      await rpcRequest(handler, {
        jsonrpc: '2.0',
        id: 5,
        method: 'resources/templates/list',
        params: {},
      }),
    )
    expect(templates.result.resourceTemplates.map((resource: { uriTemplate: string }) => resource.uriTemplate)).toEqual([
      'able://attachments/{id}',
      'able://attachments/{id}/{representation}',
      'able://articles/{slug}',
    ])

    const resources = await rpcJson(
      await rpcRequest(handler, {
        jsonrpc: '2.0',
        id: 'app-resources',
        method: 'resources/list',
        params: {},
      }),
    )
    expect(resources.result.resources).toEqual([
      expect.objectContaining({
        uri: 'ui://able/workspace.html',
        name: 'Able Desk workspace cards',
        mimeType: 'text/html;profile=mcp-app',
        _meta: { ui: { prefersBorder: false } },
      }),
    ])

    const app = await rpcJson(
      await rpcRequest(handler, {
        jsonrpc: '2.0',
        id: 'app-resource',
        method: 'resources/read',
        params: { uri: 'ui://able/workspace.html' },
      }),
    )
    expect(app.result.contents[0]).toMatchObject({
      uri: 'ui://able/workspace.html',
      mimeType: 'text/html;profile=mcp-app',
      _meta: { ui: { prefersBorder: false } },
    })
    expect(app.result.contents[0].text).toContain('<title>Able Desk</title>')
    expect(app.result.contents[0].text).toContain('Content-Security-Policy')
    expect(app.result.contents[0].text).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=/i)

    const article = await rpcJson(
      await rpcRequest(handler, {
        jsonrpc: '2.0',
        id: 6,
        method: 'resources/read',
        params: { uri: 'able://articles/safe-startup' },
      }),
    )
    expect(article.result.contents[0]).toMatchObject({
      uri: 'able://articles/safe-startup',
      mimeType: 'text/markdown; charset=utf-8',
      text: '# Safe startup\n\nDisconnect power before inspection.',
    })
    expect(helpdesk.resourceCalls).toEqual([{ actor: agent, uri: 'able://articles/safe-startup' }])

    const forbidden = await rpcJson(
      await rpcRequest(handler, {
        jsonrpc: '2.0',
        id: 7,
        method: 'resources/read',
        params: { uri: 'https://example.net/private' },
      }),
    )
    expect(forbidden.error).toMatchObject({ code: -32602 })
    expect(helpdesk.resourceCalls).toHaveLength(1)
  })

  it('keeps admin tools unavailable to agents even when called by name', async () => {
    const helpdesk = new FakeHelpdesk()
    let diagnosticsCalled = false
    const handler = createMcpHandler({
      helpdesk,
      actor: agent,
      diagnostics: async () => {
        diagnosticsCalled = true
        return { ok: true }
      },
    })

    const message = await rpcJson(
      await rpcRequest(handler, {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'able_diagnostics', arguments: {} },
      }),
    )

    expect(message.result.isError).toBe(true)
    expect(message.result.content[0].text).toContain('Tool able_diagnostics not found')
    expect(diagnosticsCalled).toBe(false)
  })

  it('enforces Streamable HTTP content negotiation and same-origin requests', async () => {
    const handler = createMcpHandler({
      helpdesk: new FakeHelpdesk(),
      actor: agent,
      diagnostics: async () => ({ ok: true }),
    })

    const missingAccept = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      }),
    )
    expect(missingAccept.status).toBe(406)

    const crossOrigin = await rpcRequest(
      handler,
      { jsonrpc: '2.0', id: 10, method: 'tools/list' },
      { origin: 'https://attacker.example' },
    )
    expect(crossOrigin.status).toBe(403)
  })
})

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function encodedJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)))
}

async function signedAccessToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  kid = 'test-key',
): Promise<string> {
  const header = encodedJson({ alg: 'RS256', typ: 'JWT', kid })
  const payload = encodedJson(claims)
  const message = new TextEncoder().encode(`${header}.${payload}`)
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, message)
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`
}

describe('Cloudflare Access identity boundary', () => {
  it('fails closed without an Access audience outside localhost and tests', async () => {
    const request = new Request('https://desk.example/mcp')
    const productionLikeEnv = { DB: workerEnv.DB } as Env

    await expect(authenticateAccess(request, productionLikeEnv)).rejects.toEqual(
      expect.objectContaining<Partial<AccessError>>({
        code: 'access_not_configured',
        status: 503,
      }),
    )
  })

  it('permits the explicit development identity only on localhost or in Worker tests', async () => {
    const localEnv = {
      DB: workerEnv.DB,
      ABLE_DEV_EMAIL: 'local-owner@example.com',
      ABLE_OWNER_EMAIL: 'local-owner@example.com',
    } as Env

    const localActor = await authenticateAccess(new Request('http://localhost/mcp'), localEnv)
    expect(localActor).toMatchObject({ email: 'local-owner@example.com', role: 'admin' })

    await expect(authenticateAccess(new Request('https://desk.example/mcp'), localEnv)).rejects.toMatchObject({
      code: 'access_not_configured',
    })

    const workerTestActor = await authenticateAccess(new Request('https://desk.example/mcp'), {
      ...localEnv,
      TEST_MIGRATIONS: workerEnv.TEST_MIGRATIONS ?? [],
    })
    expect(workerTestActor.email).toBe('local-owner@example.com')
  })

  it('verifies RS256 issuer and audience, bootstraps the owner, and provisions teammates as agents', async () => {
    const keys = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
    const now = Math.floor(Date.now() / 1000)
    const issuer = 'https://unit-test.cloudflareaccess.com'
    const fetcher: typeof fetch = async (input) => {
      expect(String(input)).toBe(`${issuer}/cdn-cgi/access/certs`)
      return Response.json({ keys: [{ ...publicJwk, alg: 'RS256', kid: 'test-key', use: 'sig' }] })
    }
    const accessEnv = {
      DB: workerEnv.DB,
      CF_ACCESS_AUD: 'application-audience',
      CF_ACCESS_TEAM_DOMAIN: issuer,
      ABLE_OWNER_EMAIL: 'owner@example.com',
    } as Env

    const ownerToken = await signedAccessToken(keys.privateKey, {
      iss: issuer,
      aud: ['another-audience', 'application-audience'],
      sub: 'owner-subject',
      email: 'OWNER@EXAMPLE.COM',
      name: 'Configured Owner',
      nbf: now - 10,
      exp: now + 300,
    })
    const ownerActor = await authenticateAccess(
      new Request('https://desk.example/mcp', { headers: { 'Cf-Access-Jwt-Assertion': ownerToken } }),
      accessEnv,
      { fetcher },
    )
    expect(ownerActor).toMatchObject({ email: 'owner@example.com', name: 'Configured Owner', role: 'admin' })

    const agentToken = await signedAccessToken(keys.privateKey, {
      iss: issuer,
      aud: 'application-audience',
      sub: 'agent-subject',
      email: 'teammate@example.com',
      name: 'Teammate',
      nbf: now - 10,
      exp: now + 300,
    })
    const teammate = await authenticateAccess(
      new Request('https://desk.example/mcp', { headers: { 'Cf-Access-Jwt-Assertion': agentToken } }),
      accessEnv,
      { fetcher },
    )
    expect(teammate).toMatchObject({ email: 'teammate@example.com', name: 'Teammate', role: 'agent' })

    const wrongAudience = await signedAccessToken(keys.privateKey, {
      iss: issuer,
      aud: 'wrong-audience',
      sub: 'agent-subject',
      email: 'teammate@example.com',
      exp: now + 300,
    })
    await expect(
      authenticateAccess(
        new Request('https://desk.example/mcp', { headers: { 'Cf-Access-Jwt-Assertion': wrongAudience } }),
        accessEnv,
        { fetcher },
      ),
    ).rejects.toMatchObject({ code: 'invalid_access_token', status: 403 })
  })
})
