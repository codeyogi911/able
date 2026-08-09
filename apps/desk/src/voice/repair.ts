/**
 * Deterministic repair for a turn that claims a knowledge gap it never
 * verified.
 *
 * The system prompt forbids saying anything is undocumented unless
 * search_help_center returned no_match in the same turn, yet the voice model
 * at temperature 0 still answers unfamiliar-product questions with "I don't
 * have information on that" without searching. The broken shape is
 * deterministic to detect — the turn made no tool call and the reply claims
 * missing documentation — so the turn is re-run once with the help-centre
 * search forced on the first step, and only the repaired turn reaches the
 * caller.
 *
 * Scope redirects for off-topic questions ("I can only help with support…",
 * "I'm not able to discuss…") assert what the assistant will not do, never
 * that documentation is missing, so they are never re-run and an off-topic
 * turn never gains a tool call. The detector keys on a claim of missing
 * knowledge material: a negated possession verb reaching a documentation
 * noun, a negated existence claim about one, or "not documented/covered".
 */

// "to answer"/"to guide" are excluded so redirect phrasings like "I don't
// have the ability to answer that" read as refusals, not as missing answers.
const NEGATED_POSSESSION = /\b(?:do(?:es)?\s?not|don['’]t|doesn['’]t|did\s?not|didn['’]t|could\s?not|couldn['’]t|can\s?not|can['’]t|cannot|unable\s+to)\b[^.!?]{0,24}?\b(?:have|find|locate|see|provide|offer|access)\b[^.!?]{0,50}?\b(?:info(?:rmation)?|document(?:ation|ed)?|article|(?<!to\s)guide|knowledge|(?<!to\s)answer|steps)\b/i
// A bare "no answer" (a device that stays silent) is not a knowledge claim;
// "answer" needs a documentation adjective here.
const NEGATED_EXISTENCE = /\b(?:there\s+(?:is|are)\s+no|no)\s+(?:(?:documented|published|available|specific)\s+answers?|(?:documented|published|available|specific)?\s*(?:info(?:rmation)?|documentation|article|guide)s?)\b/i
const NOT_DOCUMENTED = /(?:\bnot|n['’]t|\bnever)\s+(?:documented|covered)\b/i
// A reply that names the topic as general/unrelated knowledge is a scope
// redirect even when it also uses gap-like wording; redirects never repair.
const SCOPE_REDIRECT = /\b(?:general|unrelated|off[\s-]?topic)\s+(?:questions?|topics?|knowledge)\b|\bprogramming\s+(?:languages?|topics?)\b/i

/** True when the reply claims that documentation or knowledge is missing. */
export function claimsKnowledgeGap(text: string): boolean {
  if (SCOPE_REDIRECT.test(text)) return false
  return NEGATED_POSSESSION.test(text) || NEGATED_EXISTENCE.test(text) || NOT_DOCUMENTED.test(text)
}

/**
 * Per-step settings for the repaired run: the first step must call
 * search_help_center; later steps are unconstrained so the model can answer
 * from the result or continue with request_contact.
 */
export function prepareForcedSearchStep(
  { stepNumber }: { stepNumber: number },
): { toolChoice?: { type: 'tool'; toolName: 'search_help_center' } } {
  return stepNumber === 0 ? { toolChoice: { type: 'tool', toolName: 'search_help_center' } } : {}
}

/**
 * Wraps an AI SDK fullStream. Parts are buffered until the first tool call;
 * a tool call proves the turn consulted a tool, so everything is released
 * and the rest passes through live. If the turn ends with no tool call and
 * the accumulated text claims a knowledge gap, the buffered turn is
 * discarded and the rerun (which must force the search) is streamed in its
 * place. Voice replies are capped at 120 output tokens, so the buffering
 * window is small.
 */
export async function* repairUnsearchedKnowledgeGap<Part extends { type: string }>(
  stream: AsyncIterable<Part>,
  rerun: () => AsyncIterable<Part>,
): AsyncIterable<Part> {
  const buffered: Part[] = []
  let text = ''
  let toolCalled = false
  for await (const part of stream) {
    if (toolCalled) {
      yield part
      continue
    }
    const candidate = part as { type: string; text?: unknown }
    if (candidate.type === 'tool-call') {
      toolCalled = true
      for (const held of buffered) yield held
      buffered.length = 0
      yield part
      continue
    }
    if (candidate.type === 'text-delta' && typeof candidate.text === 'string') text += candidate.text
    buffered.push(part)
  }
  if (toolCalled) return
  if (!claimsKnowledgeGap(text)) {
    for (const held of buffered) yield held
    return
  }
  yield* rerun()
}
