import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ASSISTANT_PLAYBACK_TAIL_MS,
  AssistantPlaybackGuard,
  PlaybackAwareVoiceTransport,
} from '../src/voice/playback-guard'
import type { VoiceTransport } from '@cloudflare/voice/client'

function message(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function fakeTransport(): VoiceTransport {
  return {
    connected: false,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendJSON: vi.fn(),
    sendBinary: vi.fn(),
  }
}

describe('AssistantPlaybackGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })

  afterEach(() => vi.useRealTimers())

  it('keeps the mic suppressed through queued PCM playback and the echo tail', () => {
    const changes: boolean[] = []
    const guard = new AssistantPlaybackGuard((suppressed) => changes.push(suppressed))
    guard.observe(message({ type: 'audio_config', format: 'pcm16', sampleRate: 24_000 }))
    guard.observe(message({ type: 'status', status: 'speaking' }))
    guard.observe(new ArrayBuffer(4_800)) // 100 ms
    guard.observe(new ArrayBuffer(4_800)) // another 100 ms queued
    guard.observe(message({ type: 'status', status: 'listening' }))

    expect(guard.captureSuppressed).toBe(true)
    vi.advanceTimersByTime(200 + ASSISTANT_PLAYBACK_TAIL_MS - 1)
    expect(guard.captureSuppressed).toBe(true)
    vi.advanceTimersByTime(1)
    expect(guard.captureSuppressed).toBe(false)
    expect(changes).toEqual([true, false])
  })

  it('accounts for slower-than-realtime frame delivery', () => {
    const guard = new AssistantPlaybackGuard(() => {})
    guard.observe(message({ type: 'audio_config', format: 'pcm16', sampleRate: 24_000 }))
    guard.observe(message({ type: 'status', status: 'speaking' }))
    guard.observe(new ArrayBuffer(4_800))
    vi.advanceTimersByTime(150)
    guard.observe(new ArrayBuffer(4_800))
    guard.observe(message({ type: 'status', status: 'listening' }))

    vi.advanceTimersByTime(100 + ASSISTANT_PLAYBACK_TAIL_MS - 1)
    expect(guard.captureSuppressed).toBe(true)
    vi.advanceTimersByTime(1)
    expect(guard.captureSuppressed).toBe(false)
  })

  it('releases immediately when playback is interrupted', () => {
    const guard = new AssistantPlaybackGuard(() => {})
    guard.observe(message({ type: 'status', status: 'speaking' }))
    guard.observe(new ArrayBuffer(4_800))
    guard.observe(message({ type: 'playback_interrupt' }))
    expect(guard.captureSuppressed).toBe(false)
  })

  it('observes playback before forwarding messages to VoiceClient', () => {
    const inner = fakeTransport()
    const guard = new AssistantPlaybackGuard(() => {})
    const transport = new PlaybackAwareVoiceTransport(
      { agent: 'AbleDeskAgent', name: 'test' },
      guard,
      inner,
    )
    let suppressedWhenForwarded = false
    transport.onmessage = () => { suppressedWhenForwarded = guard.captureSuppressed }
    transport.connect()

    inner.onmessage?.(message({ type: 'status', status: 'speaking' }))

    expect(suppressedWhenForwarded).toBe(true)
    expect(inner.connect).toHaveBeenCalledOnce()
  })
})
