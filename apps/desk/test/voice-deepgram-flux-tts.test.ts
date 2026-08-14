import { describe, expect, it, vi } from 'vitest'
import {
  DeepgramFluxTTS,
  FallbackTTS,
  WorkersAIPcmTTS,
  deepgramFluxTTSModel,
  type DeepgramFetch,
} from '../src/voice/deepgram-flux-tts'

type SocketListener = (event: { data?: unknown }) => void

class FakeDeepgramSocket {
  readonly sent: string[] = []
  readonly listeners = new Map<string, SocketListener[]>()
  binaryType = 'blob'
  readyState = WebSocket.OPEN

  accept(): void {}

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(value: string): void {
    this.sent.push(value)
    if (value !== JSON.stringify({ type: 'Flush' })) return
    queueMicrotask(() => {
      this.emit('message', { data: new Uint8Array([1, 2]).buffer })
      this.emit('message', { data: new Uint8Array([3]).buffer })
      this.emit('message', { data: JSON.stringify({ type: 'SpeechMetadata' }) })
    })
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

describe('DeepgramFluxTTS', () => {
  it('uses the Indian-English Priya voice by default', () => {
    expect(deepgramFluxTTSModel(undefined)).toBe('flux-priya-en')
    expect(deepgramFluxTTSModel('not-a-flux-model')).toBe('flux-priya-en')
  })

  it('accepts another valid Flux English voice', () => {
    expect(deepgramFluxTTSModel(' Flux-Meena-En ')).toBe('flux-meena-en')
  })

  it('streams 24 kHz PCM from the voice-agent WebSocket', async () => {
    const socket = new FakeDeepgramSocket()
    const fetcher = vi.fn<DeepgramFetch>(async () => ({
      status: 101,
      webSocket: socket as unknown as WebSocket,
    }))
    const tts = new DeepgramFluxTTS({ apiKey: 'test-secret', fetcher })

    const frames: number[][] = []
    for await (const frame of tts.synthesizeStream('  Hello,   how can I help?  ')) {
      frames.push([...new Uint8Array(frame)])
    }

    expect(frames).toEqual([[1, 2], [3]])
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]
    expect(url.origin + url.pathname).toBe('https://api.deepgram.com/v2/speak')
    expect(url.searchParams.get('model')).toBe('flux-priya-en')
    expect(url.searchParams.get('encoding')).toBe('linear16')
    expect(url.searchParams.get('sample_rate')).toBe('24000')
    expect(init.headers).toMatchObject({
      Authorization: 'Token test-secret',
      Upgrade: 'websocket',
    })
    expect(socket.binaryType).toBe('arraybuffer')
    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'Speak', text: 'Hello, how can I help?' }),
      JSON.stringify({ type: 'Flush' }),
      JSON.stringify({ type: 'Close' }),
    ])
  })

  it('returns null when the WebSocket upgrade fails', async () => {
    const fetcher = vi.fn<DeepgramFetch>(async () => ({ status: 503 }))
    const tts = new DeepgramFluxTTS({ apiKey: 'test-secret', fetcher })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(tts.synthesize('Hello')).resolves.toBeNull()
    expect(error).toHaveBeenCalledWith(JSON.stringify({
      event: 'voice_tts_failed',
      provider: 'deepgram_flux',
      status: 503,
    }))
    error.mockRestore()
  })

  it('rejects an unexpectedly large sentence before making a request', async () => {
    const fetcher = vi.fn<DeepgramFetch>()
    const tts = new DeepgramFluxTTS({ apiKey: 'test-secret', fetcher })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(tts.synthesize('a'.repeat(2_001))).resolves.toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(JSON.stringify({
      event: 'voice_tts_failed',
      provider: 'deepgram_flux',
      reason: 'input_too_long',
    }))
    error.mockRestore()
  })

  it('falls back only when the primary produces no audio', async () => {
    const primary = { synthesize: vi.fn(async () => null) }
    const fallbackAudio = new Uint8Array([4, 5, 6]).buffer
    const fallback = { synthesize: vi.fn(async () => fallbackAudio) }
    const tts = new FallbackTTS(primary, fallback)

    await expect(tts.synthesize('Hello')).resolves.toEqual(fallbackAudio)
    expect(primary.synthesize).toHaveBeenCalledOnce()
    expect(fallback.synthesize).toHaveBeenCalledOnce()
  })

  it('streams the fallback when the primary produces no frames', async () => {
    const primary = {
      synthesize: vi.fn(async () => null),
      synthesizeStream: vi.fn(async function* () {}),
    }
    const fallbackAudio = new Uint8Array([4, 5, 6]).buffer
    const fallback = { synthesize: vi.fn(async () => fallbackAudio) }
    const tts = new FallbackTTS(primary, fallback)

    const frames: ArrayBuffer[] = []
    for await (const frame of tts.synthesizeStream('Hello')) frames.push(frame)
    expect(frames).toEqual([fallbackAudio])
  })

  it('does not speak a fallback after interruption', async () => {
    const controller = new AbortController()
    controller.abort()
    const fallback = { synthesize: vi.fn(async () => new ArrayBuffer(1)) }
    const tts = new FallbackTTS({ synthesize: vi.fn(async () => null) }, fallback)

    await expect(tts.synthesize('Hello', controller.signal)).resolves.toBeNull()
    expect(fallback.synthesize).not.toHaveBeenCalled()
  })
})

describe('WorkersAIPcmTTS', () => {
  it('requests the Cloudflare fallback in the same PCM format', async () => {
    const audio = new Uint8Array([9, 8]).buffer
    const run = vi.fn(async () => new Response(audio))
    const tts = new WorkersAIPcmTTS({ run })

    await expect(tts.synthesize('Hello')).resolves.toEqual(audio)
    expect(run).toHaveBeenCalledWith(
      '@cf/deepgram/aura-2-en',
      {
        text: 'Hello',
        speaker: 'harmonia',
        encoding: 'linear16',
        container: 'none',
        sample_rate: 24_000,
      },
      { returnRawResponse: true },
    )
  })

  it('forwards aligned audio frames before the full Aura response completes', async () => {
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => { finish = resolve })
    const first = new Uint8Array(4_800).fill(1)
    const second = new Uint8Array(2).fill(2)
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(first)
        await waiting
        controller.enqueue(second)
        controller.close()
      },
    })
    const run = vi.fn(async () => new Response(body))
    const tts = new WorkersAIPcmTTS({ run })
    const stream = tts.synthesizeStream('Hello')[Symbol.asyncIterator]()

    await expect(stream.next()).resolves.toMatchObject({ done: false, value: first.buffer })
    finish()
    await expect(stream.next()).resolves.toMatchObject({ done: false, value: second.buffer })
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('coalesces arbitrary Workers AI chunks onto complete PCM samples', async () => {
    const expected = new Uint8Array(4_802).map((_, index) => index % 251)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(expected.slice(0, 3_001))
        controller.enqueue(expected.slice(3_001))
        controller.close()
      },
    })
    const tts = new WorkersAIPcmTTS({ run: vi.fn(async () => new Response(body)) })
    const frames: ArrayBuffer[] = []
    for await (const frame of tts.synthesizeStream('Hello')) frames.push(frame)

    expect(frames.map((frame) => frame.byteLength)).toEqual([4_800, 2])
    const actual = new Uint8Array(frames.reduce((total, frame) => total + frame.byteLength, 0))
    let offset = 0
    for (const frame of frames) {
      actual.set(new Uint8Array(frame), offset)
      offset += frame.byteLength
    }
    expect(actual).toEqual(expected)
  })
})
