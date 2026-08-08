import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'

import type { Env } from '../src/env'
import { verifyPublicWrite, verifyTurnstileProof } from '../src/security/public-write'
import { normalizeOperatorHostname, requestSurface } from '../src/security/operator-host'
import { loadWorkspaceSettings, updateWorkspaceSettings } from '../src/settings'

describe('workspace email readiness', () => {
  it('invalidates the setup test and disables intake when either configured email changes', async () => {
    await env.DB.prepare(
      `UPDATE workspace_settings
       SET support_email = 'help@example.test', outbound_sender = 'sender@example.test',
           email_tested_at = '2026-07-17T03:00:00.000Z', public_intake_enabled = 1
       WHERE id = 1`,
    ).run()

    await updateWorkspaceSettings(env.DB, { outboundSender: 'new-sender@example.test' })
    expect(await loadWorkspaceSettings(env.DB)).toMatchObject({
      outboundSender: 'new-sender@example.test',
      emailTestedAt: null,
      publicIntakeEnabled: false,
    })

    await env.DB.prepare(
      `UPDATE workspace_settings
       SET email_tested_at = '2026-07-17T04:00:00.000Z', public_intake_enabled = 1
       WHERE id = 1`,
    ).run()
    await updateWorkspaceSettings(env.DB, { supportEmail: 'new-help@example.test' })
    expect(await loadWorkspaceSettings(env.DB)).toMatchObject({
      supportEmail: 'new-help@example.test',
      emailTestedAt: null,
      publicIntakeEnabled: false,
    })
  })

  it('preserves email readiness for formatting-only email updates', async () => {
    await env.DB.prepare(
      `UPDATE workspace_settings
       SET support_email = 'help@example.test', outbound_sender = 'sender@example.test',
           email_tested_at = '2026-07-17T03:00:00.000Z', public_intake_enabled = 1
       WHERE id = 1`,
    ).run()

    await updateWorkspaceSettings(env.DB, {
      supportEmail: ' HELP@EXAMPLE.TEST ',
      outboundSender: ' SENDER@EXAMPLE.TEST ',
    })
    expect(await loadWorkspaceSettings(env.DB)).toMatchObject({
      supportEmail: 'help@example.test',
      outboundSender: 'sender@example.test',
      emailTestedAt: '2026-07-17T03:00:00.000Z',
      publicIntakeEnabled: true,
    })
  })

  it('enforces repository-independent workspace safety in the settings module', async () => {
    await expect(updateWorkspaceSettings(env.DB, { supportEmail: 'not-an-email' })).rejects.toThrow('Support email is invalid')
    await expect(updateWorkspaceSettings(env.DB, { portalBaseUrl: 'https://support.example.test/hidden/path' })).rejects.toThrow('HTTPS origin')
    await expect(updateWorkspaceSettings(env.DB, { canvasColor: '#ffffff', inkColor: '#fefefe' })).rejects.toThrow('contrast')
    await expect(updateWorkspaceSettings(env.DB, { accentColor: '#b54a28', inkColor: '#b54a28' })).rejects.toThrow('contrast')

    await updateWorkspaceSettings(env.DB, { displayName: '  Example\nSupport\tDesk  ' })
    expect(await loadWorkspaceSettings(env.DB)).toMatchObject({ displayName: 'Example Support Desk' })
  })
})

describe('operator hostname boundary', () => {
  it('accepts only a bare DNS hostname', () => {
    expect(normalizeOperatorHostname(' Operators.Example.Test ')).toBe('operators.example.test')
    expect(normalizeOperatorHostname('https://operators.example.test')).toBeNull()
    expect(normalizeOperatorHostname('operators.example.test/mcp')).toBeNull()
    expect(normalizeOperatorHostname('operators.example.test:443')).toBeNull()
    expect(normalizeOperatorHostname('*.example.test')).toBeNull()
    expect(normalizeOperatorHostname('127.0.0.1')).toBeNull()
    expect(normalizeOperatorHostname('localhost')).toBeNull()
  })

  it('fails closed when production host routing is absent or mismatched', () => {
    expect(requestSurface(new URL('https://operators.example.test/mcp'))).toBe('unconfigured')
    expect(requestSurface(new URL('https://operators.example.test/mcp'), 'operators.example.test')).toBe('operator')
    expect(requestSurface(new URL('https://support.example.test/mcp'), 'operators.example.test')).toBe('public')
    expect(requestSurface(new URL('http://localhost/mcp'))).toBe('local')
  })
})

function publicEnv(secret?: string): Env {
  return {
    PUBLIC_RATE_LIMIT: {
      limit: vi.fn(async () => ({ success: true })),
    },
    ...(secret ? { TURNSTILE_SECRET_KEY: secret } : {}),
  } as unknown as Env
}

function guardedRequest(url = 'https://support.example.test/requests'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { origin: new URL(url).origin, 'CF-Connecting-IP': '203.0.113.7' },
  })
}

describe('Turnstile public-write binding', () => {
  it('binds a voice session proof to the voice action and connection hostname', async () => {
    const verified = vi.fn<typeof fetch>()
      .mockResolvedValue(Response.json({ success: true, action: 'voice_session', hostname: 'support.example.test' }))

    await expect(verifyTurnstileProof({
      token: 'voice-token',
      action: 'voice_session',
      ip: '203.0.113.7',
      hostname: 'support.example.test',
    }, publicEnv('secret'), verified)).resolves.toEqual({ ok: true })
    expect(verified).toHaveBeenCalledOnce()
  })

  it('honours the documented testing secret on the local surface only', async () => {
    // Cloudflare's dummy siteverify responses omit the action and hostname
    // claims, so the testing secret is accepted without claim checks — but
    // only for local development requests. Production hostnames keep strict
    // claim verification even when a testing secret is configured.
    const testingSecret = '1x0000000000000000000000000000000AA'
    const dummyResponse = () => vi.fn<typeof fetch>()
      .mockResolvedValue(Response.json({ success: true, hostname: 'example.com' }))

    await expect(verifyTurnstileProof({
      token: 'any-token',
      action: 'voice_session',
      ip: 'unknown',
      hostname: 'localhost',
      local: true,
    }, publicEnv(testingSecret), dummyResponse())).resolves.toEqual({ ok: true })

    await expect(verifyTurnstileProof({
      token: 'any-token',
      action: 'voice_session',
      ip: 'unknown',
      hostname: 'support.example.test',
      local: false,
    }, publicEnv(testingSecret), dummyResponse())).resolves.toEqual({ ok: false, reason: 'turnstile_action_mismatch' })

    // A real secret keeps strict claim checks even on the local surface.
    await expect(verifyTurnstileProof({
      token: 'any-token',
      action: 'voice_session',
      ip: 'unknown',
      hostname: 'localhost',
      local: true,
    }, publicEnv('real-production-secret'), dummyResponse())).resolves.toEqual({ ok: false, reason: 'turnstile_action_mismatch' })
  })

  it('accepts opaque browser origins only with same-origin fetch metadata', async () => {
    const verified = vi.fn<typeof fetch>()
      .mockResolvedValue(Response.json({ success: true, action: 'intake', hostname: 'support.example.test' }))
    const opaqueSameOrigin = new Request('https://support.example.test/requests', {
      method: 'POST',
      headers: {
        origin: 'null',
        'Sec-Fetch-Site': 'same-origin',
        'CF-Connecting-IP': '203.0.113.7',
      },
    })
    const opaqueCrossSite = new Request('https://support.example.test/requests', {
      method: 'POST',
      headers: {
        origin: 'null',
        'Sec-Fetch-Site': 'cross-site',
        'CF-Connecting-IP': '203.0.113.7',
      },
    })

    await expect(verifyPublicWrite(opaqueSameOrigin, publicEnv('secret'), 'valid-token', 'intake', verified))
      .resolves.toEqual({ ok: true })
    await expect(verifyPublicWrite(opaqueCrossSite, publicEnv('secret'), 'valid-token', 'intake', verified))
      .resolves.toEqual({ ok: false, reason: 'origin_mismatch' })
    expect(verified).toHaveBeenCalledTimes(1)
  })

  it('requires success, the expected action, and the request hostname', async () => {
    const request = guardedRequest()
    const verified = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, action: 'intake', hostname: 'support.example.test' }))
      .mockResolvedValueOnce(Response.json({ success: true, hostname: 'support.example.test' }))
      .mockResolvedValueOnce(Response.json({ success: true, action: 'reply', hostname: 'support.example.test' }))
      .mockResolvedValueOnce(Response.json({ success: true, action: 'intake', hostname: 'attacker.example' }))

    await expect(verifyPublicWrite(request, publicEnv('secret'), 'valid-token', 'intake', verified))
      .resolves.toEqual({ ok: true })
    await expect(verifyPublicWrite(request, publicEnv('secret'), 'missing-action', 'intake', verified))
      .resolves.toEqual({ ok: false, reason: 'turnstile_action_mismatch' })
    await expect(verifyPublicWrite(request, publicEnv('secret'), 'wrong-action', 'intake', verified))
      .resolves.toEqual({ ok: false, reason: 'turnstile_action_mismatch' })
    await expect(verifyPublicWrite(request, publicEnv('secret'), 'wrong-host', 'intake', verified))
      .resolves.toEqual({ ok: false, reason: 'turnstile_hostname_mismatch' })
  })

  it('allows the explicit localhost bypass only when no Turnstile secret is configured', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(verifyPublicWrite(
      guardedRequest('http://localhost/requests'),
      publicEnv(),
      null,
      'intake',
      fetcher,
    )).resolves.toEqual({ ok: true })
    expect(fetcher).not.toHaveBeenCalled()

    await expect(verifyPublicWrite(
      guardedRequest('https://support.example.test/requests'),
      publicEnv(),
      null,
      'intake',
      fetcher,
    )).resolves.toEqual({ ok: false, reason: 'turnstile_not_configured' })
  })
})
