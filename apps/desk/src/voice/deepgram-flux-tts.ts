import type { StreamingTTSProvider, TTSProvider } from '@cloudflare/voice'

const DEEPGRAM_FLUX_TTS_URL = 'https://api.deepgram.com/v2/speak'
const DEFAULT_MODEL = 'flux-priya-en'
const CONNECT_TIMEOUT_MS = 4_000
const GENERATION_TIMEOUT_MS = 15_000
const MAX_TEXT_LENGTH = 2_000
const OUTPUT_SAMPLE_RATE = 24_000
const MODEL_PATTERN = /^flux-[a-z0-9-]+-en$/

type DeepgramUpgradeResponse = {
  status: number
  webSocket?: WebSocket | null
}

export type DeepgramFetch = (
  url: URL,
  init: RequestInit,
) => Promise<DeepgramUpgradeResponse>

export type DeepgramFluxTTSOptions = {
  apiKey: string
  /** Flux TTS model identifier, for example `flux-priya-en`. */
  model?: string
  fetcher?: DeepgramFetch
}

type StreamCapableTTS = TTSProvider & Partial<StreamingTTSProvider>

function isStreaming(provider: StreamCapableTTS): provider is TTSProvider & StreamingTTSProvider {
  return typeof provider.synthesizeStream === 'function'
}

async function* providerStream(
  provider: StreamCapableTTS,
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<ArrayBuffer> {
  if (isStreaming(provider)) {
    yield* provider.synthesizeStream(text, signal)
    return
  }

  const audio = await provider.synthesize(text, signal)
  if (audio) yield audio
}

export class FallbackTTS implements TTSProvider, StreamingTTSProvider {
  constructor(
    readonly primary: StreamCapableTTS,
    readonly fallback: StreamCapableTTS,
  ) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    const audio = await this.primary.synthesize(text, signal)
    if (audio || signal?.aborted) return audio
    return this.fallback.synthesize(text, signal)
  }

  async *synthesizeStream(text: string, signal?: AbortSignal): AsyncGenerator<ArrayBuffer> {
    let producedAudio = false
    for await (const audio of providerStream(this.primary, text, signal)) {
      producedAudio = true
      yield audio
    }
    if (producedAudio || signal?.aborted) return
    yield* providerStream(this.fallback, text, signal)
  }
}

type WorkersAIBinding = {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>
}

/** Cloudflare-hosted Aura fallback that matches Flux's raw PCM wire format. */
export class WorkersAIPcmTTS implements TTSProvider {
  constructor(
    readonly ai: WorkersAIBinding,
    readonly speaker = 'harmonia',
  ) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    const speech = normalizeSpeech(text)
    if (!speech) return null
    if (speech.length > MAX_TEXT_LENGTH) {
      logTTSFailure('workers_ai_aura_2', { reason: 'input_too_long' })
      return null
    }

    try {
      const response = await this.ai.run(
        '@cf/deepgram/aura-2-en',
        {
          text: speech,
          speaker: this.speaker,
          encoding: 'linear16',
          container: 'none',
          sample_rate: OUTPUT_SAMPLE_RATE,
        },
        { returnRawResponse: true, ...(signal ? { signal } : {}) },
      ) as Response
      if (!response.ok) {
        logTTSFailure('workers_ai_aura_2', { status: response.status })
        return null
      }
      const audio = await response.arrayBuffer()
      return audio.byteLength > 0 ? audio : null
    } catch (error) {
      if (signal?.aborted) return null
      logTTSFailure('workers_ai_aura_2', {
        reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'provider',
      })
      return null
    }
  }
}

class AudioFrameQueue {
  readonly #frames: ArrayBuffer[] = []
  readonly #waiters = new Set<() => void>()
  #closed = false
  #error: Error | null = null

  push(frame: ArrayBuffer): void {
    if (this.#closed) return
    this.#frames.push(frame)
    this.#wake()
  }

  finish(): void {
    this.#closed = true
    this.#wake()
  }

  fail(error: Error): void {
    this.#error = error
    this.#closed = true
    this.#wake()
  }

  async next(): Promise<IteratorResult<ArrayBuffer>> {
    while (this.#frames.length === 0 && !this.#closed) {
      await new Promise<void>((resolve) => this.#waiters.add(resolve))
    }
    const frame = this.#frames.shift()
    if (frame) return { done: false, value: frame }
    if (this.#error) throw this.#error
    return { done: true, value: undefined }
  }

  #wake(): void {
    for (const resolve of this.#waiters) resolve()
    this.#waiters.clear()
  }
}

/**
 * Indian-English Flux TTS over Deepgram's voice-agent WebSocket. Audio is
 * yielded as 24 kHz PCM frames so the Cloudflare Voice client can begin
 * playback before the complete sentence has been synthesized.
 */
export class DeepgramFluxTTS implements TTSProvider, StreamingTTSProvider {
  readonly model: string
  readonly #apiKey: string
  readonly #fetch: DeepgramFetch

  constructor(options: DeepgramFluxTTSOptions) {
    const apiKey = options.apiKey.trim()
    if (!apiKey) throw new Error('Deepgram Flux TTS requires an API key')

    const model = (options.model ?? DEFAULT_MODEL).trim().toLowerCase()
    if (!MODEL_PATTERN.test(model)) {
      throw new Error('Deepgram Flux TTS model must match flux-{voice}-en')
    }

    this.#apiKey = apiKey
    this.model = model
    this.#fetch = options.fetcher ?? (async (url, init) => {
      const response = await fetch(url, init)
      return response as Response & { webSocket?: WebSocket | null }
    })
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    const frames: ArrayBuffer[] = []
    let byteLength = 0
    for await (const frame of this.synthesizeStream(text, signal)) {
      frames.push(frame)
      byteLength += frame.byteLength
    }
    if (byteLength === 0) return null

    const joined = new Uint8Array(byteLength)
    let offset = 0
    for (const frame of frames) {
      joined.set(new Uint8Array(frame), offset)
      offset += frame.byteLength
    }
    return joined.buffer
  }

  async *synthesizeStream(text: string, signal?: AbortSignal): AsyncGenerator<ArrayBuffer> {
    const speech = normalizeSpeech(text)
    if (!speech) return
    if (speech.length > MAX_TEXT_LENGTH) {
      logTTSFailure('deepgram_flux', { reason: 'input_too_long' })
      return
    }

    const url = new URL(DEEPGRAM_FLUX_TTS_URL)
    url.searchParams.set('model', this.model)
    url.searchParams.set('encoding', 'linear16')
    url.searchParams.set('sample_rate', String(OUTPUT_SAMPLE_RATE))

    const connectTimeout = AbortSignal.timeout(CONNECT_TIMEOUT_MS)
    const connectSignal = signal ? AbortSignal.any([signal, connectTimeout]) : connectTimeout
    let socket: WebSocket | null = null
    let generationTimeout: ReturnType<typeof setTimeout> | null = null

    try {
      const response = await this.#fetch(url, {
        headers: {
          Authorization: `Token ${this.#apiKey}`,
          Upgrade: 'websocket',
        },
        signal: connectSignal,
      })
      socket = response.webSocket ?? null
      if (!socket) {
        logTTSFailure('deepgram_flux', { status: response.status })
        return
      }

      socket.binaryType = 'arraybuffer'
      socket.accept()
      const frames = new AudioFrameQueue()
      let completed = false

      const onAbort = () => {
        frames.finish()
        socket?.close(1000, 'interrupted')
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      socket.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          frames.push(event.data)
          return
        }
        if (ArrayBuffer.isView(event.data)) {
          const view = event.data as ArrayBufferView
          frames.push(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer)
          return
        }
        if (typeof event.data !== 'string') return
        const message = parseControlMessage(event.data)
        if (message === 'SpeechMetadata') {
          completed = true
          frames.finish()
        } else if (message === 'Error') {
          frames.fail(new Error('provider'))
        }
      })
      socket.addEventListener('error', () => frames.fail(new Error('network')))
      socket.addEventListener('close', () => {
        if (!completed && !signal?.aborted) frames.fail(new Error('closed'))
        else frames.finish()
      })

      generationTimeout = setTimeout(
        () => frames.fail(new DOMException('TTS generation timed out', 'TimeoutError')),
        GENERATION_TIMEOUT_MS,
      )
      socket.send(JSON.stringify({ type: 'Speak', text: speech }))
      socket.send(JSON.stringify({ type: 'Flush' }))

      while (true) {
        const next = await frames.next()
        if (next.done) break
        yield next.value
      }

      if (!signal?.aborted) socket.send(JSON.stringify({ type: 'Close' }))
      signal?.removeEventListener('abort', onAbort)
    } catch (error) {
      if (!signal?.aborted) {
        logTTSFailure('deepgram_flux', {
          reason: error instanceof Error && error.name === 'TimeoutError'
            ? 'timeout'
            : error instanceof Error && error.message === 'provider'
              ? 'provider'
              : 'network',
        })
      }
    } finally {
      if (generationTimeout !== null) clearTimeout(generationTimeout)
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'complete')
    }
  }
}

function normalizeSpeech(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function parseControlMessage(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as { type?: unknown }
    return typeof parsed.type === 'string' ? parsed.type : null
  } catch {
    return null
  }
}

function logTTSFailure(provider: string, detail: { status?: number; reason?: string }): void {
  console.error(JSON.stringify({ event: 'voice_tts_failed', provider, ...detail }))
}

export function deepgramFluxTTSModel(configured: string | undefined): string {
  const model = configured?.trim().toLowerCase()
  return model && MODEL_PATTERN.test(model) ? model : DEFAULT_MODEL
}

export const VOICE_OUTPUT_SAMPLE_RATE = OUTPUT_SAMPLE_RATE
