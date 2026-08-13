/**
 * Turn-scoped sentence dedup for streamed assistant text.
 *
 * At temperature 0 the voice model sometimes restates a sentence it already
 * spoke earlier in the same turn — typically repeating its pre-tool-call text
 * verbatim after the tool result arrives. This module drops a sentence whose
 * normalized text already appeared in the same turn, while streaming: text is
 * released at each sentence boundary, so speech still starts on the first
 * completed sentence.
 *
 * Deliberately conservative: only exact matches (after whitespace collapse)
 * of sentences at least MIN_DEDUP_CHARS long are dropped, and the set resets
 * every turn, so legitimate repetition across turns is untouched.
 */

const MIN_DEDUP_CHARS = 10

// A completed sentence: everything up to a terminator (plus any closing
// quotes/brackets), followed by the whitespace that separates it from the
// next sentence. The whitespace requirement keeps decimals ("2.5") and
// tight joins ("you.I'm") intact rather than guessing.
const SENTENCE_BOUNDARY = /^([\s\S]*?[.!?…]["'”’)\]]*)(\s+)/

export type SentenceDedup = {
  /** Buffers text and returns whatever completed sentences survive dedup. */
  feed(text: string): string
  /** Releases the trailing partial sentence, dedup-checked, and resets. */
  flush(): string
}

function sentenceKey(sentence: string): string {
  return sentence.replace(/\s+/g, ' ').trim()
}

export function createSentenceDedup(): SentenceDedup {
  const seen = new Set<string>()
  let buffer = ''

  const release = (sentence: string, trailing: string): string => {
    const key = sentenceKey(sentence)
    if (key.length >= MIN_DEDUP_CHARS) {
      if (seen.has(key)) return ''
      seen.add(key)
    }
    return sentence + trailing
  }

  return {
    feed(text: string): string {
      buffer += text
      let output = ''
      for (;;) {
        const match = SENTENCE_BOUNDARY.exec(buffer)
        if (!match) break
        buffer = buffer.slice(match[0].length)
        output += release(match[1]!, match[2]!)
      }
      return output
    },
    flush(): string {
      const rest = buffer
      buffer = ''
      if (!rest.trim()) return rest
      return release(rest, '')
    },
  }
}

/** One-shot variant for already-complete text. */
export function dedupRepeatedSentences(text: string): string {
  const dedup = createSentenceDedup()
  return dedup.feed(text) + dedup.flush()
}

/**
 * Wraps an AI SDK fullStream, deduping the text-delta parts and passing every
 * other part through untouched. The buffered tail is flushed ahead of each
 * text-end/finish part so downstream consumers still see a complete block.
 */
export async function* dedupAssistantText<Part extends { type: string }>(
  stream: AsyncIterable<Part>,
): AsyncIterable<Part> {
  const dedup = createSentenceDedup()
  let template: Part | null = null
  for await (const part of stream) {
    const candidate = part as { type: string; text?: unknown }
    if (candidate.type === 'text-delta' && typeof candidate.text === 'string') {
      template = part
      const text = dedup.feed(candidate.text)
      if (text) yield { ...part, text } as Part
      continue
    }
    if (candidate.type === 'text-end' || candidate.type === 'finish') {
      const rest = dedup.flush()
      if (rest && template) yield { ...template, type: 'text-delta', text: rest } as Part
    }
    yield part
  }
}

/**
 * Converts a provider-side stream failure into a short assistant reply.
 *
 * The AI SDK can surface provider failures either as an `error` part or by
 * throwing while the stream is consumed. Passing either through leaves the
 * Voice client with a user turn and no assistant turn. This boundary keeps
 * provider details server-side and guarantees that the conversation returns
 * to an actionable state.
 */
export async function* recoverAssistantText<Part extends { type: string }>(
  stream: AsyncIterable<Part>,
  fallback: string,
  onError: () => void = () => {},
): AsyncIterable<Part> {
  let template: Part | null = null
  const fallbackPart = (): Part => ({
    ...(template ?? {} as Part),
    type: 'text-delta',
    text: fallback,
  } as Part)

  try {
    for await (const part of stream) {
      const candidate = part as { type: string; text?: unknown }
      if (candidate.type === 'text-delta') template = part
      if (candidate.type === 'error') {
        onError()
        yield fallbackPart()
        return
      }
      yield part
    }
  } catch {
    onError()
    yield fallbackPart()
  }
}
