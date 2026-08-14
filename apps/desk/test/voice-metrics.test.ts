import { describe, expect, it } from 'vitest'

import { readVoicePipelineMetrics } from '../src/voice/demo-agent'

describe('voice pipeline metrics', () => {
  it('accepts bounded timing-only telemetry', () => {
    expect(readVoicePipelineMetrics({
      llmMs: 450,
      ttsMs: 1_100,
      firstAudioMs: 1_550,
      totalMs: 2_700,
    })).toEqual({ llmMs: 450, ttsMs: 1_100, firstAudioMs: 1_550, totalMs: 2_700 })
  })

  it('rejects malformed or unbounded values', () => {
    expect(readVoicePipelineMetrics({ llmMs: -1, ttsMs: 1, firstAudioMs: 1, totalMs: 1 })).toBeNull()
    expect(readVoicePipelineMetrics({ llmMs: 1, ttsMs: '1', firstAudioMs: 1, totalMs: 1 })).toBeNull()
    expect(readVoicePipelineMetrics({ llmMs: 1, ttsMs: 1, firstAudioMs: 1, totalMs: 300_001 })).toBeNull()
  })
})
