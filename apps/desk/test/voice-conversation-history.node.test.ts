import { describe, expect, it } from 'vitest'

import { mergeConversationHistory, type RestoredTranscriptMessage } from '../src/voice/conversation-history'

const message = (role: 'user' | 'assistant', text: string, timestamp: number): RestoredTranscriptMessage => ({ role, text, timestamp })

describe('mergeConversationHistory', () => {
  it('appends the fresh post-login transcript to persisted history', () => {
    const persisted = [message('user', 'Help me choose a grinder', 1), message('assistant', 'What is your budget?', 2)]
    const current = [message('user', 'I have signed in', 3), message('assistant', 'You are signed in.', 4)]
    expect(mergeConversationHistory(persisted, current).map(({ text }) => text)).toEqual([
      'Help me choose a grinder',
      'What is your budget?',
      'I have signed in',
      'You are signed in.',
    ])
  })

  it('does not duplicate messages retained by VoiceClient on reconnect', () => {
    const persisted = [message('user', 'Track my order', 1), message('assistant', 'Sign in below.', 2)]
    const current = [message('user', 'Track my order', 10), message('assistant', 'Sign in below.', 11)]
    expect(mergeConversationHistory(persisted, current)).toEqual(persisted)
  })

  it('preserves only the non-overlapping continuation', () => {
    const persisted = [message('user', 'Track my order', 1), message('assistant', 'Sign in below.', 2)]
    const current = [message('assistant', 'Sign in below.', 11), message('assistant', 'Here are your orders.', 12)]
    expect(mergeConversationHistory(persisted, current).map(({ text }) => text)).toEqual([
      'Track my order',
      'Sign in below.',
      'Here are your orders.',
    ])
  })
})
