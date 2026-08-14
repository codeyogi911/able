export type RestoredTranscriptMessage = {
  role: 'user' | 'assistant'
  text: string
  timestamp: number
}

function sameMessage(left: RestoredTranscriptMessage, right: RestoredTranscriptMessage): boolean {
  return left.role === right.role && left.text === right.text
}

/**
 * Join persisted server history to the current VoiceClient transcript without
 * duplicating the overlap retained across an automatic WebSocket reconnect.
 */
export function mergeConversationHistory(
  persisted: RestoredTranscriptMessage[],
  current: RestoredTranscriptMessage[],
): RestoredTranscriptMessage[] {
  const maximumOverlap = Math.min(persisted.length, current.length)
  for (let overlap = maximumOverlap; overlap > 0; overlap--) {
    const persistedStart = persisted.length - overlap
    let matches = true
    for (let index = 0; index < overlap; index++) {
      if (!sameMessage(persisted[persistedStart + index]!, current[index]!)) {
        matches = false
        break
      }
    }
    if (matches) return [...persisted, ...current.slice(overlap)]
  }
  return [...persisted, ...current]
}
