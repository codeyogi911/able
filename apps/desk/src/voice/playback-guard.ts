import {
  WebSocketVoiceTransport,
  type VoiceAudioFormat,
  type VoiceTransport,
} from '@cloudflare/voice/client'

const PCM16_BYTES_PER_SAMPLE = 2

/**
 * Browser echo cancellation is useful but not reliable enough to decide
 * whether speaker output is a new customer turn. Keep capture suppressed
 * briefly after the final queued sample so room echo cannot reopen the mic.
 */
export const ASSISTANT_PLAYBACK_TAIL_MS = 350

type VoiceWireData = string | ArrayBuffer | Blob

type AudioConfigMessage = {
  type: 'audio_config'
  format?: unknown
  sampleRate?: unknown
}

type StatusMessage = {
  type: 'status'
  status?: unknown
}

function readServerMessage(data: string): AudioConfigMessage | StatusMessage | { type: string } | null {
  try {
    const value: unknown = JSON.parse(data)
    if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return null
    return value as AudioConfigMessage | StatusMessage | { type: string }
  } catch {
    return null
  }
}

/**
 * Tracks the assistant's real PCM playback window rather than relying only on
 * the server's `speaking` status. The server can finish generating audio while
 * the browser still has several seconds queued for playback.
 */
export class AssistantPlaybackGuard {
  #audioFormat: VoiceAudioFormat | null = null
  #sampleRate = 16_000
  #serverSpeaking = false
  #receivedAudio = false
  #playbackEndsAt = 0
  #releaseTimer: ReturnType<typeof setTimeout> | null = null
  #captureSuppressed = false

  constructor(readonly onSuppressionChange: (suppressed: boolean) => void) {}

  get captureSuppressed(): boolean {
    return this.#captureSuppressed
  }

  observe(data: VoiceWireData): void {
    if (typeof data !== 'string') {
      this.#observeAudio(data instanceof Blob ? data.size : data.byteLength)
      return
    }

    const message = readServerMessage(data)
    if (!message) return
    if (message.type === 'audio_config') {
      const config = message as AudioConfigMessage
      if (config.format === 'mp3' || config.format === 'pcm16' || config.format === 'wav' || config.format === 'opus') {
        this.#audioFormat = config.format
      }
      if (typeof config.sampleRate === 'number' && Number.isFinite(config.sampleRate) && config.sampleRate > 0) {
        this.#sampleRate = config.sampleRate
      }
      return
    }
    if (message.type === 'playback_interrupt') {
      this.reset()
      return
    }
    if (message.type !== 'status') return

    const status = (message as StatusMessage).status
    if (status === 'speaking') this.#startAssistantTurn()
    else if (status === 'listening') this.#finishAssistantTurn()
    else if (status === 'idle') this.reset()
  }

  reset(): void {
    this.#clearReleaseTimer()
    this.#serverSpeaking = false
    this.#receivedAudio = false
    this.#playbackEndsAt = 0
    this.#setSuppressed(false)
  }

  #startAssistantTurn(): void {
    this.#clearReleaseTimer()
    if (!this.#serverSpeaking) {
      this.#receivedAudio = false
      this.#playbackEndsAt = Date.now()
    }
    this.#serverSpeaking = true
    this.#setSuppressed(true)
  }

  #observeAudio(byteLength: number): void {
    if (!this.#serverSpeaking || byteLength <= 0) return
    this.#receivedAudio = true
    this.#setSuppressed(true)
    if (this.#audioFormat !== 'pcm16') return

    const durationMs = byteLength / (this.#sampleRate * PCM16_BYTES_PER_SAMPLE) * 1_000
    this.#playbackEndsAt = Math.max(Date.now(), this.#playbackEndsAt) + durationMs
  }

  #finishAssistantTurn(): void {
    this.#serverSpeaking = false
    if (!this.#receivedAudio) {
      this.#setSuppressed(false)
      return
    }

    this.#clearReleaseTimer()
    const releaseAt = this.#audioFormat === 'pcm16'
      ? this.#playbackEndsAt + ASSISTANT_PLAYBACK_TAIL_MS
      : Date.now() + ASSISTANT_PLAYBACK_TAIL_MS
    const delay = Math.max(0, Math.ceil(releaseAt - Date.now()))
    this.#releaseTimer = setTimeout(() => {
      this.#releaseTimer = null
      if (!this.#serverSpeaking) this.#setSuppressed(false)
    }, delay)
  }

  #clearReleaseTimer(): void {
    if (this.#releaseTimer === null) return
    clearTimeout(this.#releaseTimer)
    this.#releaseTimer = null
  }

  #setSuppressed(suppressed: boolean): void {
    if (this.#captureSuppressed === suppressed) return
    this.#captureSuppressed = suppressed
    this.onSuppressionChange(suppressed)
  }
}

type WebSocketTransportOptions = ConstructorParameters<typeof WebSocketVoiceTransport>[0]

/** Observe server playback without forking Cloudflare's voice client. */
export class PlaybackAwareVoiceTransport implements VoiceTransport {
  readonly #transport: VoiceTransport
  readonly #guard: AssistantPlaybackGuard

  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((error?: unknown) => void) | null = null
  onmessage: ((data: VoiceWireData) => void) | null = null

  constructor(
    options: WebSocketTransportOptions,
    guard: AssistantPlaybackGuard,
    transport: VoiceTransport = new WebSocketVoiceTransport(options),
  ) {
    this.#transport = transport
    this.#guard = guard
  }

  get connected(): boolean {
    return this.#transport.connected
  }

  connect(): void {
    this.#transport.onopen = () => this.onopen?.()
    this.#transport.onclose = () => {
      this.#guard.reset()
      this.onclose?.()
    }
    this.#transport.onerror = (error) => this.onerror?.(error)
    this.#transport.onmessage = (data) => {
      this.#guard.observe(data)
      this.onmessage?.(data)
    }
    this.#transport.connect()
  }

  disconnect(): void {
    this.#guard.reset()
    this.#transport.disconnect()
  }

  sendJSON(data: Record<string, unknown>): void {
    this.#transport.sendJSON(data)
  }

  sendBinary(data: ArrayBuffer): void {
    this.#transport.sendBinary(data)
  }
}
