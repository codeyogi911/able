import { describe, expect, it } from 'vitest'

import { createSentenceDedup, dedupAssistantText, dedupRepeatedSentences } from '../src/voice/dedup'

describe('sentence dedup', () => {
  it('drops a verbatim repeated block within one turn', () => {
    const input = "I'm sorry to hear that. Let's narrow this down. What type of router is it? I'm sorry to hear that. Let's narrow this down. What type of router is it?"
    expect(dedupRepeatedSentences(input)).toBe(
      "I'm sorry to hear that. Let's narrow this down. What type of router is it? ",
    )
  })

  it('keeps distinct sentences and new content after a repeated prefix', () => {
    const input = 'Let me check that for you. Let me check that for you. Your order shipped yesterday.'
    expect(dedupRepeatedSentences(input)).toBe('Let me check that for you. Your order shipped yesterday.')
  })

  it('leaves short interjections and tight joins alone', () => {
    expect(dedupRepeatedSentences('Yes. Yes.')).toBe('Yes. Yes.')
    // No whitespace after the terminator means no boundary is assumed.
    expect(dedupRepeatedSentences('It costs 2.5 dollars total.')).toBe('It costs 2.5 dollars total.')
  })

  it('streams: releases sentences at boundaries and dedups the flushed tail', () => {
    const dedup = createSentenceDedup()
    let out = ''
    out += dedup.feed('Try another outlet first. ')
    expect(out).toBe('Try another outlet first. ')
    out += dedup.feed('Try another ')
    out += dedup.feed('outlet first.')
    out += dedup.flush()
    expect(out).toBe('Try another outlet first. ')
  })

  it('wraps a fullStream, deduping text-deltas and passing other parts through', async () => {
    async function* stream() {
      yield { type: 'text-delta', id: 't1', text: 'Let me look that up. ' }
      yield { type: 'tool-call', toolName: 'search_help_center' }
      yield { type: 'text-delta', id: 't2', text: 'Let me look that up. Clean every 60 days.' }
      yield { type: 'finish' }
    }
    const parts: Array<{ type: string; text?: string }> = []
    for await (const part of dedupAssistantText(stream())) parts.push(part)

    const text = parts.filter((part) => part.type === 'text-delta').map((part) => part.text).join('')
    expect(text).toBe('Let me look that up. Clean every 60 days.')
    expect(parts.some((part) => part.type === 'tool-call')).toBe(true)
    expect(parts.at(-1)?.type).toBe('finish')
  })
})
