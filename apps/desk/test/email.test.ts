import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deliverOutbox, queueSetupTest } from '../src/email/outbox'
import type { Env } from '../src/env'
import { createHelpdesk } from '../src/helpdesk'
import type { Actor, CaseWorkspace } from '../src/domain/types'
import { updateWorkspaceSettings } from '../src/settings'
import worker from '../src/worker'
import { emailFixture, ForwardableEmailFixture } from './helpers/email-fixture'

const LOCAL_CAPABILITY_SECRET = 'able-local-capability-secret-not-for-production'
const workerBindings = env as unknown as Env

type SentEmail = {
  from: { email: string; name: string }
  to: string
  replyTo: string
  subject: string
  text: string
  html: string
  headers: Record<string, string>
}

function runtimeEnv(
  email: SendEmail | null = null,
  capabilitySecret?: string,
  db: D1Database = workerBindings.DB,
): Env {
  return {
    DB: db,
    ATTACHMENTS: workerBindings.ATTACHMENTS,
    EMAIL: email as unknown as SendEmail,
    MEDIA_QUEUE: workerBindings.MEDIA_QUEUE,
    ASSETS: workerBindings.ASSETS,
    PUBLIC_RATE_LIMIT: workerBindings.PUBLIC_RATE_LIMIT,
    ABLE_DEV_EMAIL: 'owner@example.com',
    TEST_MIGRATIONS: workerBindings.TEST_MIGRATIONS,
    ...(capabilitySecret ? { CUSTOMER_CAPABILITY_SECRET: capabilitySecret } : {}),
  } as Env
}

function failBatchCall(db: D1Database, callToFail: number): D1Database {
  let calls = 0
  const batch: D1Database['batch'] = async (statements) => {
    calls += 1
    const results = await db.batch(statements)
    if (calls === callToFail) throw new Error('simulated D1 acknowledgement loss')
    return results
  }
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'batch') return batch
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function emailService(send: (message: SentEmail) => Promise<EmailSendResult>): SendEmail {
  return { send } as unknown as SendEmail
}

async function configureEmail(): Promise<void> {
  await env.DB.prepare(
    `UPDATE workspace_settings
     SET portal_base_url = 'https://support.example.test',
         support_email = 'support@example.test',
         outbound_sender = 'help@example.test',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = 1`,
  ).run()
}

async function receive(raw: string): Promise<ForwardableEmailFixture> {
  const message = new ForwardableEmailFixture(raw)
  await worker.email(message, runtimeEnv())
  return message
}

async function count(table: string): Promise<number> {
  const allowed = new Set(['cases', 'messages', 'attachments', 'operation_receipts', 'outbox_rows'])
  if (!allowed.has(table)) throw new Error(`Unsupported count table: ${table}`)
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
  return row?.count ?? 0
}

describe('inbound email channel', () => {
  beforeEach(configureEmail)

  it('opens a new case and commits the receipt and magic-link outbox atomically', async () => {
    const message = await receive(emailFixture({
      subject: 'Display turns off during warm-up',
      messageId: '<new-case-001@example.test>',
      text: 'The display turns off after about one minute.',
    }))

    expect(message.rejectReason).toBeNull()
    const row = await env.DB.prepare(
      `SELECT cases.ref, cases.channel, cases.status, messages.body_text,
              operation_receipts.scope, outbox_rows.state, outbox_rows.body_text AS outbox_body
       FROM cases
       JOIN messages ON messages.case_id = cases.id
       JOIN operation_receipts ON operation_receipts.case_id = cases.id
       JOIN outbox_rows ON outbox_rows.case_id = cases.id`,
    ).first<{
      ref: string
      channel: string
      status: string
      body_text: string
      scope: string
      state: string
      outbox_body: string
    }>()

    expect(row).toMatchObject({
      ref: 'AD-1',
      channel: 'email',
      status: 'open',
      body_text: 'The display turns off after about one minute.',
      scope: 'email',
      state: 'queued',
    })
    expect(row?.outbox_body).toContain('{{able_customer_capability}}')
    expect(await count('cases')).toBe(1)
    expect(await count('messages')).toBe(1)
    expect(await count('operation_receipts')).toBe(1)
    expect(await count('outbox_rows')).toBe(1)
  })

  it.each([
    { name: 'Able Desk reference', marker: 'AD-1', legacy: false },
    { name: 'generic legacy alias', marker: 'LEG-902', legacy: true },
  ])('threads a reply by $name and deduplicates the Message-ID', async ({ marker, legacy }) => {
    await receive(emailFixture({
      subject: 'Startup problem',
      messageId: '<thread-root@example.test>',
      text: 'The first report establishes the customer and case.',
    }))
    const original = await env.DB.prepare('SELECT id, public_id, ref FROM cases').first<{
      id: number
      public_id: string
      ref: string
    }>()
    expect(original).not.toBeNull()

    if (legacy) {
      await env.DB.prepare(
        `INSERT INTO external_provenance
           (id, source, entity_type, source_id, local_entity_type, local_entity_id,
            lookup_alias, raw_sha256, metadata_json)
         VALUES ('legacy-case-902', 'legacy-desk', 'ticket', '902', 'case', ?, ?, ?, '{}')`,
      ).bind(String(original!.id), marker, 'a'.repeat(64)).run()
    }
    await env.DB.prepare("UPDATE cases SET status = 'resolved' WHERE id = ?").bind(original!.id).run()

    const replyRaw = emailFixture({
      subject: `Re: [${marker}] Startup problem`,
      messageId: `<thread-reply-${legacy ? 'legacy' : 'able'}@example.test>`,
      text: 'I tried the checklist and the case should reopen.',
    })
    const first = await receive(replyRaw)
    const replay = await receive(replyRaw)

    expect(first.rejectReason).toBeNull()
    expect(replay.rejectReason).toBeNull()
    expect(await count('cases')).toBe(1)
    expect(await count('messages')).toBe(2)
    expect(await count('operation_receipts')).toBe(2)
    const reopened = await env.DB.prepare('SELECT status, ref FROM cases WHERE id = ?')
      .bind(original!.id)
      .first<{ status: string; ref: string }>()
    expect(reopened).toEqual({ status: 'open', ref: original!.ref })
  })

  it('suppresses automated replies without creating or rejecting customer state', async () => {
    const message = await receive(emailFixture({
      subject: 'Automatic response',
      messageId: '<automatic-001@example.test>',
      text: 'This mailbox has received your message.',
      headers: { 'Auto-Submitted': 'auto-replied' },
    }))

    expect(message.rejectReason).toBeNull()
    expect(await count('cases')).toBe(0)
    expect(await count('messages')).toBe(0)
    expect(await count('operation_receipts')).toBe(0)
    expect(await count('outbox_rows')).toBe(0)
  })

  it('deduplicates an attachment-bearing provider retry by Message-ID', async () => {
    const raw = emailFixture({
      subject: 'Provider may redeliver this attachment',
      messageId: '<attachment-retry-001@example.test>',
      text: 'The same provider event must not create a second message or object.',
      attachment: {
        filename: 'same-diagnostic.txt',
        contentType: 'text/plain',
        content: 'same diagnostic bytes',
      },
    })

    const first = await receive(raw)
    const replay = await receive(raw)

    expect(first.rejectReason).toBeNull()
    expect(replay.rejectReason).toBeNull()
    expect(await count('cases')).toBe(1)
    expect(await count('messages')).toBe(1)
    expect(await count('attachments')).toBe(1)
    expect(await count('operation_receipts')).toBe(1)
    const objects = await env.ATTACHMENTS.list()
    expect(objects.objects).toHaveLength(1)
  })

  it('threads a real customer reply from the subject emitted by an operator response', async () => {
    await receive(emailFixture({
      subject: 'Round-trip threading',
      messageId: '<round-trip-root@example.test>',
      text: 'Please respond and let me reply to the emitted subject.',
    }))
    const desk = createHelpdesk({
      db: env.DB,
      attachments: env.ATTACHMENTS,
      baseUrl: 'https://support.example.test',
      capabilitySecret: LOCAL_CAPABILITY_SECRET,
    })
    const actor: Actor = { id: 'round-trip-agent', email: 'agent@example.test', name: 'Support Agent', role: 'agent' }
    const next = await desk.work(actor, { kind: 'next' }) as CaseWorkspace
    await desk.act(actor, {
      kind: 'reply',
      ref: next.ref,
      revision: next.revision,
      body: 'This reply must carry the canonical case marker.',
    })
    const emitted = await env.DB.prepare("SELECT subject FROM outbox_rows WHERE kind = 'public_reply'").first<{ subject: string }>()
    expect(emitted?.subject).toMatch(/\[AD-1\]/)

    const customerReply = await receive(emailFixture({
      subject: emitted!.subject,
      messageId: '<round-trip-customer-reply@example.test>',
      text: 'This is the actual reply using the emitted subject unchanged.',
    }))
    expect(customerReply.rejectReason).toBeNull()
    expect(await count('cases')).toBe(1)
    expect(await count('messages')).toBe(3)
    expect(await env.DB.prepare('SELECT status FROM cases').first()).toEqual({ status: 'open' })
  })

  it('threads a reply by RFC message headers and keeps its attachment on the original case', async () => {
    await receive(emailFixture({
      subject: 'Machine not working',
      messageId: '<machine-report-001@example.test>',
      text: 'The steam function has stopped working.',
    }))

    const reply = await receive(emailFixture({
      subject: 'Re: Machine not working',
      messageId: '<machine-video-002@example.test>',
      text: 'This is the issue in the attached video.',
      headers: {
        'In-Reply-To': '<machine-report-001@example.test>',
        References: '<machine-report-001@example.test>',
      },
      attachment: {
        filename: 'machine-steam.mp4',
        contentType: 'video/mp4',
        content: 'video evidence bytes',
      },
    }))

    expect(reply.rejectReason).toBeNull()
    expect(await count('cases')).toBe(1)
    expect(await count('messages')).toBe(2)
    expect(await count('attachments')).toBe(1)
    const attachment = await env.DB.prepare(
      `SELECT cases.ref, messages.body_text, stored_files.filename
       FROM case_attachments
       JOIN cases ON cases.id = case_attachments.case_id
       JOIN messages ON messages.id = case_attachments.message_id
       JOIN stored_files ON stored_files.id = case_attachments.file_id`,
    ).first<{ ref: string; body_text: string; filename: string }>()
    expect(attachment).toEqual({
      ref: 'AD-1',
      body_text: 'This is the issue in the attached video.',
      filename: 'machine-steam.mp4',
    })
  })
})

describe('durable outbound email', () => {
  beforeEach(configureEmail)

  it('durably claims a row as sending before network I/O and never sends an accepted row twice', async () => {
    const id = await queueSetupTest(env.DB, 'claim@example.test')
    let claimed: { state: string; attempt_count: number; lease_id: string | null; lease_expires_at: string | null } | null = null
    const send = vi.fn(async (_message: SentEmail) => {
      claimed = await env.DB.prepare(
        'SELECT state, attempt_count, lease_id, lease_expires_at FROM outbox_rows WHERE id = ?',
      ).bind(id).first<typeof claimed>()
      return { messageId: 'provider-accepted-claim' }
    })

    const first = await deliverOutbox(runtimeEnv(emailService(send), LOCAL_CAPABILITY_SECRET))
    const second = await deliverOutbox(runtimeEnv(emailService(send), LOCAL_CAPABILITY_SECRET))

    expect(claimed).toMatchObject({ state: 'sending', attempt_count: 1 })
    expect(claimed?.lease_id).toBeTruthy()
    expect(claimed?.lease_expires_at).toBeTruthy()
    expect(first).toMatchObject({ considered: 1, accepted: 1 })
    expect(second).toMatchObject({ considered: 0, accepted: 0 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('makes provider acceptance indeterminate when its persistence acknowledgement fails', async () => {
    const id = await queueSetupTest(env.DB, 'uncertain@example.test')
    const send = vi.fn(async (_message: SentEmail) => ({ messageId: 'provider-accepted-uncertain' }))
    // Delivery begins with one batch that reconciles expired claims. The next
    // batch is the atomic provider-acceptance persistence step.
    const dbWithLostAcknowledgement = failBatchCall(env.DB, 2)

    const run = await deliverOutbox(
      runtimeEnv(emailService(send), LOCAL_CAPABILITY_SECRET, dbWithLostAcknowledgement),
    )

    expect(run).toEqual({ considered: 1, accepted: 0, failed: 0, blocked: 0, indeterminate: 1 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(await env.DB.prepare(
      'SELECT state, attempt_count, provider_message_id, lease_id, lease_expires_at FROM outbox_rows WHERE id = ?',
    ).bind(id).first()).toMatchObject({
      state: 'indeterminate',
      attempt_count: 1,
      provider_message_id: 'provider-accepted-uncertain',
      lease_id: null,
      lease_expires_at: null,
    })
    expect(await env.DB.prepare('SELECT email_tested_at FROM workspace_settings WHERE id = 1').first())
      .toMatchObject({ email_tested_at: null })

    expect(await deliverOutbox(runtimeEnv(emailService(send), LOCAL_CAPABILITY_SECRET))).toMatchObject({ considered: 0 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('turns an expired sending claim into a terminal indeterminate result without network I/O', async () => {
    const id = await queueSetupTest(env.DB, 'expired@example.test')
    await env.DB.prepare(
      `UPDATE outbox_rows
       SET state = 'sending', attempt_count = 1, lease_id = 'abandoned-lease',
           lease_expires_at = datetime('now', '-1 second')
       WHERE id = ?`,
    ).bind(id).run()
    const send = vi.fn(async (_message: SentEmail) => ({ messageId: 'must-not-send-expired-claim' }))

    const run = await deliverOutbox(runtimeEnv(emailService(send), LOCAL_CAPABILITY_SECRET))

    expect(run).toMatchObject({ considered: 0, accepted: 0, failed: 0 })
    expect(send).not.toHaveBeenCalled()
    expect(await env.DB.prepare('SELECT state, attempt_count, last_error, lease_id FROM outbox_rows WHERE id = ?')
      .bind(id)
      .first()).toMatchObject({
      state: 'indeterminate',
      attempt_count: 1,
      lease_id: null,
    })
  })

  it('does not record acceptance when the durable claim expires during provider I/O', async () => {
    const id = await queueSetupTest(env.DB, 'lease-loss@example.test')
    const send = vi.fn(async (_message: SentEmail) => {
      await env.DB.prepare("UPDATE outbox_rows SET lease_expires_at = datetime('now', '-1 second') WHERE id = ?")
        .bind(id)
        .run()
      return { messageId: 'provider-accepted-after-lease-loss' }
    })

    const run = await deliverOutbox(runtimeEnv(emailService(send), LOCAL_CAPABILITY_SECRET))

    expect(run).toMatchObject({ considered: 1, accepted: 0, indeterminate: 1 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(await env.DB.prepare('SELECT state, provider_message_id FROM outbox_rows WHERE id = ?')
      .bind(id)
      .first()).toMatchObject({
      state: 'indeterminate',
      provider_message_id: 'provider-accepted-after-lease-loss',
    })
    expect(await deliverOutbox(runtimeEnv(emailService(send), LOCAL_CAPABILITY_SECRET))).toMatchObject({ considered: 0 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('materializes the HMAC capability only for provider acceptance and authorizes the private attachment', async () => {
    await receive(emailFixture({
      subject: 'Diagnostic file and unsafe text',
      messageId: '<attachment-001@example.test>',
      text: 'Visible customer text: <script>alert("stored")</script>',
      attachment: {
        filename: 'diagnostic.txt',
        contentType: 'text/plain',
        content: 'private diagnostic content',
      },
    }))

    const attachment = await env.DB.prepare('SELECT id, storage_key, sha256 FROM attachments').first<{
      id: string
      storage_key: string
      sha256: string
    }>()
    expect(attachment).not.toBeNull()
    const object = await env.ATTACHMENTS.get(attachment!.storage_key)
    expect(await object?.text()).toBe('private diagnostic content')

    const send = vi.fn(async (_message: SentEmail) => ({ messageId: 'provider-accepted-001' }))
    const run = await deliverOutbox(
      runtimeEnv(emailService(send), LOCAL_CAPABILITY_SECRET),
    )

    expect(run).toEqual({ considered: 1, accepted: 1, failed: 0, blocked: 0, indeterminate: 0 })
    expect(send).toHaveBeenCalledTimes(1)
    const delivered = send.mock.calls[0]![0]
    expect(delivered.headers['X-Able-Outbox-ID']).toBeTruthy()
    expect(delivered.text).not.toContain('{{able_customer_capability}}')
    expect(delivered.html).not.toContain('%7B%7Bable_customer_capability%7D%7D')
    expect(delivered.html).not.toContain('%7B%7Bcase_ref%7D%7D')
    expect(delivered.html).toContain('https://support.example.test/requests/recover?ref=AD-1')
    const link = /https:\/\/support\.example\.test\/requests\/access#([A-Za-z0-9_-]{32,})/.exec(delivered.text)
    expect(link).not.toBeNull()
    const capability = link![1]!
    expect(new URL(link![0]!).pathname).toBe('/requests/access')

    const persisted = await env.DB.prepare(
      `SELECT outbox_rows.state, outbox_rows.provider_message_id, outbox_rows.body_text,
              cases.customer_capability_nonce, cases.customer_capability_hash,
              messages.delivery_state
       FROM outbox_rows
       JOIN cases ON cases.id = outbox_rows.case_id
       JOIN messages ON messages.id = outbox_rows.message_id`,
    ).first<{
      state: string
      provider_message_id: string
      body_text: string
      customer_capability_nonce: string
      customer_capability_hash: string
      delivery_state: string
    }>()
    expect(persisted).toMatchObject({
      state: 'accepted',
      provider_message_id: 'provider-accepted-001',
      body_text: '[redacted after provider acceptance]',
      delivery_state: 'accepted',
    })
    expect(JSON.stringify(persisted)).not.toContain(capability)

    const bootstrap = await SELF.fetch('https://support.example.test/requests/access')
    const bootstrapHtml = await bootstrap.text()
    expect(bootstrap.status).toBe(200)
    expect(bootstrapHtml).toContain('/requests/capability-bootstrap.js')
    expect(bootstrapHtml).not.toContain(capability)

    const exchange = await SELF.fetch('https://support.example.test/requests/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://support.example.test',
        'x-able-capability-exchange': '1',
      },
      body: JSON.stringify({ capability }),
    })
    expect(exchange.status).toBe(204)
    const setCookie = exchange.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Strict')
    const cookie = setCookie.split(';', 1)[0]!

    const privateThread = await SELF.fetch('https://support.example.test/requests/case', {
      headers: { cookie },
    })
    const privateHtml = await privateThread.text()
    expect(privateThread.status).toBe(200)
    expect(privateHtml).not.toContain('<script>alert("stored")</script>')
    expect(privateHtml).toContain('&lt;script&gt;alert(&quot;stored&quot;)&lt;/script&gt;')
    expect(privateHtml).not.toContain(capability)

    const download = await SELF.fetch(
      `https://support.example.test/requests/attachments/${encodeURIComponent(attachment!.id)}`,
      { headers: { cookie } },
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('cache-control')).toContain('no-store')
    expect(download.headers.get('content-disposition')).toContain('diagnostic.txt')
    expect(await download.text()).toBe('private diagnostic content')

    const unauthorized = await SELF.fetch(`https://support.example.test/requests/attachments/${encodeURIComponent(attachment!.id)}`)
    expect(unauthorized.status).toBe(404)

    const legacyCapabilityPath = await SELF.fetch(`https://support.example.test/requests/${capability}`)
    expect(legacyCapabilityPath.status).toBe(404)
  })

  it('keeps blocked delivery terminal and retries only a definitive failed attempt', async () => {
    const blockedId = await queueSetupTest(env.DB, 'blocked@example.test')
    const blocked = await deliverOutbox(runtimeEnv(null, LOCAL_CAPABILITY_SECRET))
    expect(blocked).toEqual({ considered: 1, accepted: 0, failed: 0, blocked: 1, indeterminate: 0 })
    const blockedRow = await env.DB.prepare('SELECT state, attempt_count, last_error FROM outbox_rows WHERE id = ?')
      .bind(blockedId)
      .first<{ state: string; attempt_count: number; last_error: string }>()
    expect(blockedRow).toMatchObject({ state: 'blocked', attempt_count: 1 })
    expect(blockedRow?.last_error).toContain('not configured')

    const wouldAccept = vi.fn(async (_message: SentEmail) => ({ messageId: 'must-not-send-blocked' }))
    expect(await deliverOutbox(runtimeEnv(emailService(wouldAccept), LOCAL_CAPABILITY_SECRET))).toMatchObject({ considered: 0 })
    expect(wouldAccept).not.toHaveBeenCalled()

    const retryId = await queueSetupTest(env.DB, 'retry@example.test')
    const transient = vi.fn(async (_message: SentEmail): Promise<EmailSendResult> => {
      throw Object.assign(new Error('provider rate limit'), { code: 'E_RATE_LIMIT_EXCEEDED' })
    })
    const failed = await deliverOutbox(runtimeEnv(emailService(transient), LOCAL_CAPABILITY_SECRET))
    expect(failed).toEqual({ considered: 1, accepted: 0, failed: 1, blocked: 0, indeterminate: 0 })
    expect(await env.DB.prepare('SELECT state, attempt_count FROM outbox_rows WHERE id = ?').bind(retryId).first()).toMatchObject({
      state: 'failed',
      attempt_count: 1,
    })

    await env.DB.prepare("UPDATE outbox_rows SET next_attempt_at = datetime('now', '-1 second') WHERE id = ?")
      .bind(retryId)
      .run()
    const recoveredSend = vi.fn(async (_message: SentEmail) => ({ messageId: 'provider-accepted-retry' }))
    const recovered = await deliverOutbox(runtimeEnv(emailService(recoveredSend), LOCAL_CAPABILITY_SECRET))
    expect(recovered).toEqual({ considered: 1, accepted: 1, failed: 0, blocked: 0, indeterminate: 0 })
    expect(await env.DB.prepare('SELECT state, attempt_count, provider_message_id FROM outbox_rows WHERE id = ?').bind(retryId).first()).toMatchObject({
      state: 'accepted',
      attempt_count: 2,
      provider_message_id: 'provider-accepted-retry',
    })

    const exhaustedId = await queueSetupTest(env.DB, 'exhausted@example.test')
    await env.DB.prepare("UPDATE outbox_rows SET attempt_count = 4, next_attempt_at = datetime('now', '-1 second') WHERE id = ?")
      .bind(exhaustedId)
      .run()
    const exhausted = await deliverOutbox(runtimeEnv(emailService(transient), LOCAL_CAPABILITY_SECRET))
    expect(exhausted).toMatchObject({ considered: 1, blocked: 1, failed: 0 })
    expect(await env.DB.prepare('SELECT state, attempt_count FROM outbox_rows WHERE id = ?').bind(exhaustedId).first()).toMatchObject({
      state: 'blocked',
      attempt_count: 5,
    })
  })

  it('never retries an ambiguous provider error and scrubs a materializable capability template', async () => {
    await receive(emailFixture({
      subject: 'Ambiguous submission',
      messageId: '<ambiguous-submission@example.test>',
      text: 'The provider may have accepted this before its internal error.',
    }))
    const send = vi.fn(async (_message: SentEmail): Promise<EmailSendResult> => {
      throw Object.assign(new Error('provider internal response was lost'), { code: 'E_INTERNAL_SERVER_ERROR' })
    })

    const run = await deliverOutbox(runtimeEnv(emailService(send), LOCAL_CAPABILITY_SECRET))

    expect(run).toEqual({ considered: 1, accepted: 0, failed: 0, blocked: 0, indeterminate: 1 })
    expect(await env.DB.prepare('SELECT state, attempt_count, body_text, last_error FROM outbox_rows').first()).toMatchObject({
      state: 'indeterminate',
      attempt_count: 1,
      body_text: '[redacted after provider acceptance]',
    })
    expect(await deliverOutbox(runtimeEnv(emailService(send), LOCAL_CAPABILITY_SECRET))).toMatchObject({ considered: 0 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('makes an explicit permanent provider rejection terminal without retry', async () => {
    const id = await queueSetupTest(env.DB, 'unverified-sender@example.test')
    const send = vi.fn(async (_message: SentEmail): Promise<EmailSendResult> => {
      throw Object.assign(new Error('sender domain is not verified'), { code: 'E_SENDER_NOT_VERIFIED' })
    })

    const run = await deliverOutbox(runtimeEnv(emailService(send), LOCAL_CAPABILITY_SECRET))

    expect(run).toEqual({ considered: 1, accepted: 0, failed: 0, blocked: 1, indeterminate: 0 })
    expect(await env.DB.prepare('SELECT state, attempt_count FROM outbox_rows WHERE id = ?').bind(id).first()).toMatchObject({
      state: 'blocked',
      attempt_count: 1,
    })
    expect(await deliverOutbox(runtimeEnv(emailService(send), LOCAL_CAPABILITY_SECRET))).toMatchObject({ considered: 0 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps public intake gated until the outbound setup test is accepted', async () => {
    await expect(updateWorkspaceSettings(env.DB, { publicIntakeEnabled: true })).rejects.toThrow(
      'Public intake cannot be enabled until outbound email passes a setup test',
    )

    await queueSetupTest(env.DB, 'owner@example.test')
    const send = vi.fn(async (_message: SentEmail) => ({ messageId: 'setup-provider-acceptance' }))
    expect(await deliverOutbox(runtimeEnv(emailService(send), LOCAL_CAPABILITY_SECRET))).toMatchObject({ accepted: 1 })
    const settings = await env.DB.prepare('SELECT email_tested_at, public_intake_enabled, setup_completed_at FROM workspace_settings WHERE id = 1')
      .first<{ email_tested_at: string | null; public_intake_enabled: number; setup_completed_at: string | null }>()
    expect(settings?.email_tested_at).toBeTruthy()
    expect(settings?.public_intake_enabled).toBe(0)

    await updateWorkspaceSettings(env.DB, { publicIntakeEnabled: true })
    expect(await env.DB.prepare('SELECT setup_completed_at FROM workspace_settings WHERE id = 1').first())
      .toMatchObject({ setup_completed_at: expect.any(String) })
    const form = new FormData()
    form.set('request_id', 'setup-gate-request-001')
    form.set('name', 'Avery Customer')
    form.set('email', 'avery@example.test')
    form.set('subject', 'The setup gate is now open')
    form.set('body', 'This request is accepted only after provider setup succeeds.')
    const intake = await SELF.fetch('http://localhost/requests', { method: 'POST', body: form })

    expect(intake.status).toBe(201)
    expect(await intake.text()).toContain('We have the detail.')
    expect(await count('cases')).toBe(1)
  })
})
