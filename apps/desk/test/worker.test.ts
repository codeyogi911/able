import { createExecutionContext, createMessageBatch, env, getQueueResult, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { deliverOutbox } from '../src/email/outbox'
import type { Env } from '../src/env'
import worker from '../src/worker'

const LOCAL_CAPABILITY_SECRET = 'morrow-local-capability-secret-not-for-production'

type RpcEnvelope = {
  result?: {
    content?: Array<{ type: string; text: string }>
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }
  error?: { code: number; message: string }
}

async function rpc(id: string, name: string, arguments_: Record<string, unknown> = {}): Promise<RpcEnvelope> {
  const response = await SELF.fetch('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: arguments_ },
    }),
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/json')
  return response.json<RpcEnvelope>()
}

function toolPayload(message: RpcEnvelope): Record<string, any> {
  expect(message.error).toBeUndefined()
  expect(message.result?.isError).toBe(false)
  const text = message.result?.content?.[0]?.text
  expect(text).toBeTypeOf('string')
  const payload = JSON.parse(text!) as Record<string, any>
  expect(message.result?.structuredContent).toEqual(payload)
  return payload
}

describe('Morrow Desk Worker boundary', () => {
  it('processes stored attachment evidence through the media queue consumer', async () => {
    const bytes = new TextEncoder().encode('Customer diagnostic log from an uploaded file')
    await env.ATTACHMENTS.put('media/queued.txt', bytes)
    await env.DB.prepare(
      `INSERT INTO stored_files (id, storage_key, filename, content_type, size, sha256)
       VALUES ('file_queued', 'media/queued.txt', 'queued.txt', 'text/plain', ?, 'queued-sha')`,
    ).bind(bytes.byteLength).run()
    const handler = worker as unknown as {
      queue?: (batch: MessageBatch<{ kind: 'process_media' }>, env: Env, ctx: ExecutionContext) => void | Promise<void>
    }
    expect(handler.queue).toBeTypeOf('function')
    const batch = createMessageBatch('morrow-test-media', [{
      id: 'media-message-1',
      timestamp: new Date('2026-07-18T00:00:00.000Z'),
      attempts: 1,
      body: { kind: 'process_media' as const },
    }])
    const ctx = createExecutionContext()

    await handler.queue!(batch, env as unknown as Env, ctx)
    await getQueueResult(batch, ctx)

    await expect(env.DB.prepare(
      `SELECT status, analysis_markdown FROM file_intelligence WHERE file_id = 'file_queued'`,
    ).first()).resolves.toEqual({
      status: 'ready',
      analysis_markdown: 'Customer diagnostic log from an uploaded file',
    })
  })

  it('isolates the public portal from the Access-protected operator hostname', async () => {
    const publicHome = await SELF.fetch('https://support.example.test/')
    expect(publicHome.status).toBe(200)

    const publicMcp = await SELF.fetch('https://support.example.test/mcp')
    const publicOps = await SELF.fetch('https://support.example.test/ops')
    expect(publicMcp.status).toBe(404)
    expect(publicOps.status).toBe(404)
    expect(publicMcp.headers.get('cache-control')).toBe('no-store')

    const operatorHome = await SELF.fetch('https://operators.example.test/')
    const operatorKnowledge = await SELF.fetch('https://operators.example.test/kb')
    const operatorHealth = await SELF.fetch('https://operators.example.test/healthz')
    expect(operatorHome.status).toBe(404)
    expect(operatorKnowledge.status).toBe(404)
    expect(operatorHealth.status).toBe(404)

    const operatorOps = await SELF.fetch('https://operators.example.test/ops')
    expect(operatorOps.status).toBe(200)
    expect(await operatorOps.text()).toContain('Recovery console')

    const operatorMcp = await SELF.fetch('https://operators.example.test/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'host-boundary', method: 'tools/list' }),
    })
    expect(operatorMcp.status).toBe(200)
  })

  it('redirects legacy assistant pages to the fail-safe home while keeping the agent disabled by default', async () => {
    const voicePage = await SELF.fetch('https://support.example.test/voice', { redirect: 'manual' })
    const demoPage = await SELF.fetch('https://support.example.test/demo/voice', { redirect: 'manual' })
    const agent = await SELF.fetch('https://support.example.test/agents/morrow-desk-agent/session-1')

    expect(voicePage.status).toBe(308)
    expect(voicePage.headers.get('location')).toBe('https://support.example.test/')
    expect(demoPage.status).toBe(308)
    expect(demoPage.headers.get('location')).toBe('https://support.example.test/')
    expect(agent.status).toBe(404)
  })

  it('serves health and a CSP-protected portal while public intake fails closed', async () => {
    const health = await SELF.fetch('https://support.example.test/healthz')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    expect(health.headers.get('cache-control')).toBe('no-store')
    expect(health.headers.get('x-content-type-options')).toBe('nosniff')

    const home = await SELF.fetch('https://support.example.test/')
    const homeHtml = await home.text()
    expect(home.status).toBe(200)
    expect(homeHtml).toContain('Morrow Desk')
    expect(homeHtml).toContain('How can we help?')
    expect(homeHtml).not.toContain(['Fix', 'Company'].join(' '))
    expect(home.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(home.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(home.headers.get('x-frame-options')).toBe('DENY')
    expect(home.headers.get('permissions-policy')).toContain('payment=()')

    const requestPage = await SELF.fetch('https://support.example.test/requests/new')
    const requestHtml = await requestPage.text()
    expect(requestPage.status).toBe(200)
    expect(requestPage.headers.get('cache-control')).toContain('no-store')
    expect(requestHtml).toContain('New requests are temporarily paused')
    expect(requestHtml).toContain('disabled')

    const form = new FormData()
    form.set('request_id', 'fail-closed-request-001')
    form.set('name', 'Public Customer')
    form.set('email', 'customer@example.test')
    form.set('subject', 'This should remain closed')
    form.set('body', 'No request should exist before outbound setup passes.')
    const rejected = await SELF.fetch('https://support.example.test/requests', { method: 'POST', body: form })
    expect(rejected.status).toBe(503)
    expect(rejected.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(await rejected.text()).toContain('New requests are temporarily paused')
    const cases = await env.DB.prepare('SELECT COUNT(*) AS count FROM cases').first<{ count: number }>()
    expect(cases?.count).toBe(0)
  })

  it('lets the admin agent customize portal branding and renders it publicly', async () => {
    const customized = toolPayload(await rpc('portal-branding', 'morrow_portal_customize', {
      display_name: 'Example Company',
      portal_title: 'How can we help?',
      logo_url: 'https://cdn.example.test/support-mark.svg',
      favicon_url: 'https://cdn.example.test/favicon.png',
      home_url: 'https://example.test/',
      accent_color: '#c87942',
      canvas_color: '#ffffff',
      ink_color: '#121212',
      font_family: 'humanist',
    }))
    expect(customized).toMatchObject({
      schemaVersion: 'portal-customization.v1',
      displayName: 'Example Company',
      faviconUrl: 'https://cdn.example.test/favicon.png',
      customCssSupported: false,
    })

    const home = await SELF.fetch('http://localhost/')
    const html = await home.text()
    const theme = await (await SELF.fetch('http://localhost/workspace-theme.css')).text()
    expect(html).toContain('Example Company')
    expect(html).toContain('<link rel="icon" href="https://cdn.example.test/favicon.png"')
    expect(html).toContain('src="https://cdn.example.test/support-mark.svg"')
    expect(html).toContain('Browse by topic')
    expect(theme).toContain('--accent:#c87942')
    expect(theme).toContain('--accent-ink:#000000')
    expect(theme).toContain('--footer:#956e5c')
    expect(theme).toContain('Optima')
    expect(await env.DB.prepare(
      "SELECT event_type, evidence_json FROM audit_events WHERE event_type = 'workspace.settings_updated'",
    ).first()).toMatchObject({ event_type: 'workspace.settings_updated' })

    const rejected = await rpc('portal-branding-invalid', 'morrow_portal_customize', {
      favicon_url: 'javascript:alert(1)',
    })
    expect(rejected.result?.isError).toBe(true)
    expect(rejected.result?.content?.[0]?.text).toContain('valid HTTPS URL')
    expect((await env.DB.prepare('SELECT favicon_url FROM workspace_settings WHERE id = 1').first<{ favicon_url: string }>())?.favicon_url)
      .toBe('https://cdn.example.test/favicon.png')
  })

  it('replays an attachment-bearing portal form without duplicate state or R2 objects', async () => {
    await env.DB.prepare(
      `UPDATE workspace_settings
       SET portal_base_url = 'http://localhost', support_email = 'support@example.test',
           outbound_sender = 'help@example.test', email_tested_at = CURRENT_TIMESTAMP,
           public_intake_enabled = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
    ).run()

    const submit = async () => {
      const form = new FormData()
      form.set('request_id', 'portal-attachment-replay-001')
      form.set('name', 'Replay Customer')
      form.set('email', 'replay@example.test')
      form.set('subject', 'Attachment should not duplicate')
      form.set('body', 'The browser is retrying the exact same form submission.')
      form.set('attachments', new File(['stable attachment bytes'], 'diagnostic.txt', { type: 'text/plain' }))
      return SELF.fetch('http://localhost/requests', { method: 'POST', body: form })
    }

    const first = await submit()
    const replay = await submit()
    const firstHtml = await first.text()
    const replayHtml = await replay.text()

    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(firstHtml).toContain('MD-1')
    expect(replayHtml).toContain('MD-1')
    expect(firstHtml).not.toContain('morrow_customer_capability')
    expect(replayHtml).not.toContain('morrow_customer_capability')
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM cases').first()).toEqual({ count: 1 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM messages').first()).toEqual({ count: 1 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM operation_receipts').first()).toEqual({ count: 1 })
    expect((await env.ATTACHMENTS.list()).objects).toHaveLength(1)
  })

  it('handles a full customer intake, MCP resolution, customer follow-up, and final MCP resolution', async () => {
    await env.DB.prepare(
      `UPDATE workspace_settings
       SET portal_base_url = 'http://localhost', support_email = 'support@example.test',
           outbound_sender = 'help@example.test', email_tested_at = CURRENT_TIMESTAMP,
           public_intake_enabled = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
    ).run()

    const intakeForm = new FormData()
    intakeForm.set('request_id', 'mcp-tracer-request-001')
    intakeForm.set('name', 'Mina Customer')
    intakeForm.set('email', 'mina@example.test')
    intakeForm.set('subject', 'Machine stops during warm-up')
    intakeForm.set('body', 'The display goes blank after one minute of warm-up.')
    const intake = await SELF.fetch('http://localhost/requests', { method: 'POST', body: intakeForm })
    expect(intake.status).toBe(201)
    expect(await intake.text()).toContain('MD-1')

    const next = toolPayload(await rpc('next', 'morrow_case_next'))
    expect(next).toMatchObject({
      kind: 'case',
      ref: 'MD-1',
      subject: 'Machine stops during warm-up',
      status: 'open',
      priority: 'normal',
      customer: { name: 'Mina Customer', email: 'mina@example.test' },
      assignee: null,
    })
    expect(next.revision).toMatch(/^rev_/)
    expect(next.thread).toEqual([
      expect.objectContaining({
        visibility: 'public',
        direction: 'inbound',
        body: 'The display goes blank after one minute of warm-up.',
      }),
    ])
    expect(JSON.stringify(next)).not.toMatch(/capabilit|magic.?link|access_token|secret/i)

    const reply = toolPayload(await rpc('reply', 'morrow_case_reply', {
      ref: next.ref,
      revision: next.revision,
      body: 'Please disconnect power, then try the safe startup checklist.',
    }))
    expect(reply).toMatchObject({
      replayed: false,
      delivery: 'queued',
      case: {
        ref: 'MD-1',
        status: 'waiting_on_customer',
        assignee: { email: 'owner@example.com' },
      },
    })
    expect(reply.case.revision).not.toBe(next.revision)
    expect(reply.case.thread.at(-1)).toMatchObject({
      visibility: 'public',
      direction: 'outbound',
      body: 'Please disconnect power, then try the safe startup checklist.',
      delivery: 'queued',
    })

    const persisted = await env.DB.prepare(
      `SELECT cases.status, cases.assignee_id, messages.delivery_state, outbox_rows.state
       FROM cases
       JOIN messages ON messages.case_id = cases.id AND messages.direction = 'outbound'
       JOIN outbox_rows ON outbox_rows.message_id = messages.id`,
    ).first<{
      status: string
      assignee_id: string | null
      delivery_state: string
      state: string
    }>()
    expect(persisted).toMatchObject({
      status: 'waiting_on_customer',
      delivery_state: 'queued',
      state: 'queued',
    })
    expect(persisted?.assignee_id).toBeTruthy()

    const delivered: Array<{ subject: string; text: string; html: string }> = []
    const delivery = await deliverOutbox({
      ...(env as unknown as Env),
      CUSTOMER_CAPABILITY_SECRET: LOCAL_CAPABILITY_SECRET,
      EMAIL: {
        send: async (message) => {
          delivered.push({ subject: message.subject, text: message.text, html: message.html })
          return { messageId: `provider-e2e-${delivered.length}` }
        },
      } as SendEmail,
    })
    expect(delivery).toMatchObject({ considered: 2, accepted: 2, blocked: 0, failed: 0, indeterminate: 0 })
    const privateLinkEmail = delivered.find((message) => message.text.includes('Open your private case'))
    expect(privateLinkEmail).toBeTruthy()
    expect(privateLinkEmail?.text).not.toContain('{{morrow_customer_capability}}')
    const privateUrl = privateLinkEmail!.text.match(/https?:\/\/\S+\/requests\/access#[A-Za-z0-9_-]+/)?.[0]
    expect(privateUrl).toBeTruthy()
    const capability = new URL(privateUrl!).hash.slice(1)
    expect(capability).toBeTruthy()
    expect(await env.DB.prepare(
      "SELECT state, body_text, body_html FROM outbox_rows WHERE kind = 'customer_magic_link'",
    ).first()).toMatchObject({
      state: 'accepted',
      body_text: '[redacted after provider acceptance]',
      body_html: '<p>[redacted after provider acceptance]</p>',
    })
    const session = await SELF.fetch('http://localhost/requests/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        'x-morrow-capability-exchange': '1',
      },
      body: JSON.stringify({ capability }),
    })
    expect(session.status).toBe(204)
    const customerCookie = session.headers.get('set-cookie')?.split(';', 1)[0]
    expect(customerCookie).toContain('__Host-morrow_case=')

    const customerView = await SELF.fetch('http://localhost/requests/case', {
      headers: { cookie: customerCookie! },
    })
    const customerViewHtml = await customerView.text()
    expect(customerView.status).toBe(200)
    expect(customerViewHtml).toContain('Please disconnect power, then try the safe startup checklist.')

    const customerReplyForm = new FormData()
    customerReplyForm.set('request_id', 'mcp-customer-follow-up-001')
    customerReplyForm.set('body', 'The checklist worked briefly, but pressure dropped again after ten minutes.')
    const customerReply = await SELF.fetch('http://localhost/requests/case', {
      method: 'POST',
      headers: { cookie: customerCookie! },
      body: customerReplyForm,
    })
    expect(customerReply.status).toBe(202)
    expect(await customerReply.text()).toContain('Your message is in the conversation.')

    const reopened = toolPayload(await rpc('reopened', 'morrow_case_get', { ref: 'MD-1' }))
    expect(reopened).toMatchObject({ status: 'open' })
    expect(reopened.thread.at(-1)).toMatchObject({
      visibility: 'public',
      direction: 'inbound',
      body: 'The checklist worked briefly, but pressure dropped again after ten minutes.',
    })

    const note = toolPayload(await rpc('note', 'morrow_case_add_note', {
      ref: reopened.ref,
      revision: reopened.revision,
      body: 'Customer completed the startup checklist; persistent pressure loss now needs service follow-up.',
    }))
    expect(note.case).toMatchObject({ status: 'open' })
    expect(note.delivery).toBeNull()

    const finalReply = toolPayload(await rpc('final-reply', 'morrow_case_reply', {
      ref: note.case.ref,
      revision: note.case.revision,
      body: 'Thanks for confirming the checklist result. We have enough detail to arrange the next service step.',
    }))
    expect(finalReply.case).toMatchObject({ status: 'waiting_on_customer' })

    const resolved = toolPayload(await rpc('resolve', 'morrow_case_update', {
      ref: finalReply.case.ref,
      revision: finalReply.case.revision,
      status: 'resolved',
    }))
    expect(resolved.case).toMatchObject({ ref: 'MD-1', status: 'resolved' })

    const finalCustomerView = await SELF.fetch('http://localhost/requests/case', {
      headers: { cookie: customerCookie! },
    })
    const finalCustomerHtml = await finalCustomerView.text()
    expect(finalCustomerView.status).toBe(200)
    expect(finalCustomerHtml).toContain('We have enough detail to arrange the next service step.')
    expect(finalCustomerHtml).not.toContain('persistent pressure loss now needs service follow-up')

    const finalSearch = toolPayload(await rpc('final-search', 'morrow_case_search', { query: 'MD-1' }))
    expect(finalSearch.cases).toEqual([
      expect.objectContaining({ ref: 'MD-1', status: 'resolved' }),
    ])
  })

  it('runs the persisted Desk and CRM tracer through MCP', async () => {
    await env.DB.prepare(
      `UPDATE workspace_settings
       SET portal_base_url = 'http://localhost', support_email = 'support@example.test',
           outbound_sender = 'help@example.test', email_tested_at = CURRENT_TIMESTAMP,
           public_intake_enabled = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
    ).run()
    const intakeForm = new FormData()
    intakeForm.set('request_id', 'desk-crm-tracer-request-001')
    intakeForm.set('name', 'CRM Tracer Customer')
    intakeForm.set('email', 'crm-tracer@example.test')
    intakeForm.set('subject', 'Follow up after the support resolution')
    intakeForm.set('body', 'Please resolve this case and check back with me on Monday.')
    const intake = await SELF.fetch('http://localhost/requests', { method: 'POST', body: intakeForm })
    expect(intake.status).toBe(201)

    const next = toolPayload(await rpc('crm-next', 'morrow_case_next'))
    const unresolved = toolPayload(await rpc('crm-workspace-unresolved', 'morrow_customer_workspace', { ref: next.ref }))
    expect(unresolved).toMatchObject({
      schemaVersion: 'customer-workspace.v1',
      subject: { caseRef: next.ref, partyId: null },
      unknowns: ['directory_party_unresolved', 'crm_relationship_unavailable'],
    })

    const adopted = toolPayload(await rpc('crm-adopt', 'morrow_party_adopt', {
      ref: next.ref,
      revision: next.revision,
      intent_id: 'intent-worker-adopt-customer',
    }))
    const partyId = adopted.receipt.party.id as string
    const relationship = toolPayload(await rpc('crm-relationship', 'morrow_crm_relationship', {
      party_id: partyId,
      intent_id: 'intent-worker-create-relationship',
      status: 'customer',
    }))
    const activity = toolPayload(await rpc('crm-activity', 'morrow_crm_activity', {
      party_id: partyId,
      intent_id: 'intent-worker-record-activity',
      revision: relationship.relationship.revision,
      activity_kind: 'support',
      summary: 'Resolved the support case and recorded the requested check-in.',
      occurred_at: '2026-07-18T13:00:00.000Z',
      source_case_ref: next.ref,
    }))
    const followUp = toolPayload(await rpc('crm-followup', 'morrow_crm_followup', {
      party_id: partyId,
      intent_id: 'intent-worker-schedule-followup',
      revision: activity.relationshipRevision,
      subject: 'Confirm the support outcome',
      due_at: '2026-07-20T09:00:00.000Z',
    }))
    const tracked = toolPayload(await rpc('crm-operation-track', 'morrow_operation_track', {
      operation_id: followUp.operationId,
      intent_id: 'intent-worker-track-followup',
      contract_name: 'crm.followup-confirmed.v1',
      intended_effect: 'Confirm the promised customer follow-up happened.',
      authoritative_source: 'operator_confirmation',
      accepted_definition: 'The follow-up was durably scheduled.',
      delivered_definition: 'The follow-up reached the customer channel.',
      success_definition: 'An authenticated operator confirmed the completed follow-up.',
      failure_definition: 'The follow-up could not be completed.',
      indeterminate_definition: 'No authoritative confirmation is available before expiry.',
      recovery_policy: 'human_review',
      guard_metric: 'customer.opt_out_rate',
      not_before: '2026-07-20T09:00:00.000Z',
      expires_at: '2026-07-27T09:00:00.000Z',
    }))
    const telemetry = toolPayload(await rpc('crm-operation-telemetry', 'morrow_operation_observe', {
      operation_id: followUp.operationId,
      revision: tracked.closure.revision,
      intent_id: 'intent-worker-observe-telemetry',
      source: 'runtime_telemetry',
      observed_at: '2026-07-20T09:05:00.000Z',
      result: 'succeeded',
      summary: 'The follow-up command executed without an error.',
    }))
    expect(telemetry.closure).toMatchObject({ status: 'pending', reconciliation: 'pending' })
    const confirmed = toolPayload(await rpc('crm-operation-confirmed', 'morrow_operation_observe', {
      operation_id: followUp.operationId,
      revision: telemetry.closure.revision,
      intent_id: 'intent-worker-observe-confirmation',
      source: 'operator_confirmation',
      source_revision: 'confirmation-1',
      observed_at: '2026-07-20T10:00:00.000Z',
      result: 'succeeded',
      summary: 'The operator confirmed the customer follow-up was completed.',
    }))
    expect(confirmed.closure).toMatchObject({ status: 'succeeded', reconciliation: 'reconciled' })

    const proposed = toolPayload(await rpc('crm-improvement-propose', 'morrow_improvement_propose', {
      intent_id: 'intent-worker-propose-playbook',
      scope: 'tenant',
      artifact_kind: 'playbook',
      target_key: 'crm.followup.confirmation',
      base_version: 'v1',
      candidate_version: 'v2',
      evidence_operation_id: followUp.operationId,
    }))
    const selfEvaluation = await rpc('crm-improvement-evaluate', 'morrow_improvement_evaluate', {
      intent_id: 'intent-worker-evaluate-playbook',
      proposal_id: proposed.proposal.id,
      revision: proposed.proposal.revision,
      suite_version: 'tenant-followup-evals.v1',
      passed: true,
      summary: 'Targeted and regression fixtures passed.',
    })
    expect(selfEvaluation.error).toBeUndefined()
    expect(selfEvaluation.result.isError).toBe(true)
    expect(selfEvaluation.result.content[0].text).toContain('different administrator')
    expect(proposed.proposal.status).toBe('proposed')
    const composed = toolPayload(await rpc('crm-workspace-composed', 'morrow_customer_workspace', { ref: next.ref }))

    expect(composed).toMatchObject({
      schemaVersion: 'customer-workspace.v1',
      subject: { caseRef: next.ref, partyId },
      revisions: {
        helpdesk: next.revision,
        directory: adopted.receipt.party.revision,
        crm: followUp.relationshipRevision,
      },
      crm: {
        relationship: { status: 'customer', owner: { email: 'owner@example.com' } },
        activities: [{ kind: 'support', source: { module: 'helpdesk', entityType: 'case', entityId: next.ref } }],
        followUps: [{ subject: 'Confirm the support outcome', status: 'scheduled' }],
      },
      unknowns: [],
    })
    expect(new Set([
      adopted.receipt.operationId,
      relationship.operationId,
      activity.operationId,
      followUp.operationId,
    ]).size).toBe(4)
  })
})
