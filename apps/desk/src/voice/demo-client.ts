import { VoiceClient, type TranscriptMessage, type VoiceStatus } from '@cloudflare/voice/client'
import './demo.css'
import { SIGN_IN_CONTINUATION } from './contact'
import { HUMAN_HELP_MESSAGE } from './escalation'

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Voice support element missing: ${selector}`)
  return element
}

const elements = {
  app: required<HTMLElement>('#support-app'),
  thread: required<HTMLElement>('#thread'),
  transcript: required<HTMLOListElement>('#transcript'),
  landingPanel: required<HTMLElement>('#landing-panel'),
  landingForm: required<HTMLFormElement>('#landing-form'),
  landingInput: required<HTMLInputElement>('#landing-input'),
  landingSubmit: required<HTMLButtonElement>('#landing-submit'),
  landingMicButton: required<HTMLButtonElement>('#landing-mic-button'),
  humanHelpButton: required<HTMLButtonElement>('#human-help-button'),
  conversationHumanButton: required<HTMLButtonElement>('#conversation-human-button'),
  landingStatus: required<HTMLElement>('#landing-status'),
  composerBar: required<HTMLElement>('#composer-bar'),
  signinFlow: required<HTMLLIElement>('#signin-flow'),
  signinLead: required<HTMLElement>('#signin-card-lead'),
  signinCopy: required<HTMLElement>('#signin-card-copy'),
  signinButton: required<HTMLButtonElement>('#signin-button'),
  sessionTurnstile: required<HTMLElement>('#session-turnstile'),
  reconnectBanner: required<HTMLElement>('#reconnect-banner'),
  clearButton: required<HTMLButtonElement>('#clear-button'),
  micButton: required<HTMLButtonElement>('#mic-button'),
  muteButton: required<HTMLButtonElement>('#mute-button'),
  textForm: required<HTMLFormElement>('#text-form'),
  textInput: required<HTMLInputElement>('#text-input'),
  textSubmit: required<HTMLButtonElement>('#text-form button[type="submit"]'),
  handoffCard: required<HTMLLIElement>('#handoff-card'),
  handoffCategory: required<HTMLElement>('#handoff-category'),
  handoffDescription: required<HTMLElement>('#handoff-description'),
  handoffReference: required<HTMLElement>('#handoff-reference'),
  handoffStatus: required<HTMLElement>('#handoff-status'),
}

const supportTaskButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-support-message]')]

const RESET_FOCUS_KEY = 'able-voice-support-reset-focus'

const SIGNIN_RESUME_KEY = 'able-signin-resume-session'
const returnedFromSignIn = new URLSearchParams(window.location.search).has('signed_in')

function sessionName(): string {
  // Help always opens at its landing page. A browser refresh is a new visit,
  // not an accidental restoration of a previous transcript — with one
  // exception: returning from the hosted store sign-in resumes the exact
  // conversation that requested it.
  if (returnedFromSignIn) {
    try {
      const stored = sessionStorage.getItem(SIGNIN_RESUME_KEY)
      sessionStorage.removeItem(SIGNIN_RESUME_KEY)
      if (stored && /^voice-[a-z0-9]{20}$/.test(stored)) return stored
    } catch {
      // Fall through to a fresh session.
    }
  }
  return `voice-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
}

const activeSessionName = sessionName()
if (returnedFromSignIn) history.replaceState(null, '', window.location.pathname)

const client = new VoiceClient({
  agent: 'AbleDeskAgent',
  name: activeSessionName,
  preferredFormat: 'mp3',
})

let connected = false
let hasConnected = false
let callActive = false
let sessionReady = false
let signInContinuationPending = returnedFromSignIn

type SignInReason = 'order_lookup' | 'open_ticket'
let signinReason: SignInReason | null = null

type SourceArticle = { title: string; section: string; url: string }

let latestMessages: TranscriptMessage[] = []
const hiddenTranscriptMessages = new Set<string>()
let notes: { anchor: number; text: string }[] = []
let sources: { anchor: number; articles: SourceArticle[] }[] = []
let ticketAnchor: number | null = null
let signinAnchor: number | null = null
let interimText = ''
let typing = false
let resetReload: ReturnType<typeof setTimeout> | null = null

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const viewportListenerAbort = new AbortController()

function syncSupportViewport(): void {
  const stickToBottom = elements.app.dataset.view === 'conversation' && isNearBottom()
  const viewport = window.visualViewport
  const height = Math.max(1, Math.round(viewport?.height ?? window.innerHeight))
  const offsetTop = Math.max(0, Math.round(viewport?.offsetTop ?? 0))
  document.documentElement.style.setProperty('--support-viewport-height', `${height}px`)
  document.documentElement.style.setProperty('--support-viewport-top', `${offsetTop}px`)
  if (stickToBottom) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        elements.thread.scrollTop = elements.thread.scrollHeight
      })
    })
  }
}

window.addEventListener('resize', syncSupportViewport, { signal: viewportListenerAbort.signal })
window.visualViewport?.addEventListener('resize', syncSupportViewport, { signal: viewportListenerAbort.signal })
window.visualViewport?.addEventListener('scroll', syncSupportViewport, { signal: viewportListenerAbort.signal })
syncSupportViewport()

function isReady(): boolean {
  return connected && sessionReady
}

function reloadFreshSession(): void {
  try {
    sessionStorage.setItem(RESET_FOCUS_KEY, '1')
  } catch {
    // A reload still clears the VoiceClient's in-memory transcript when
    // session storage is unavailable.
  }
  window.location.reload()
}

function focusAfterReset(): boolean {
  try {
    if (sessionStorage.getItem(RESET_FOCUS_KEY) !== '1') return false
    sessionStorage.removeItem(RESET_FOCUS_KEY)
    return true
  } catch {
    return false
  }
}

function isNearBottom(): boolean {
  const thread = elements.thread
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120
}

function scrollToBottom(): void {
  elements.thread.scrollTo({
    top: elements.thread.scrollHeight,
    behavior: reducedMotion.matches ? 'auto' : 'smooth',
  })
}

function srLabel(text: string): HTMLElement {
  const label = document.createElement('span')
  label.className = 'sr-only'
  label.textContent = text
  return label
}

function messageRow(message: TranscriptMessage): HTMLLIElement {
  const assistant = message.role === 'assistant'
  const row = document.createElement('li')
  row.className = `answer-turn answer-turn--${assistant ? 'assistant' : 'user'}`
  const label = document.createElement('p')
  label.className = 'turn-label'
  label.textContent = assistant ? 'Answer' : 'You asked'
  const copy = document.createElement('div')
  copy.className = 'turn-copy'
  const text = document.createElement(assistant ? 'p' : 'h2')
  text.textContent = message.text
  copy.append(srLabel(assistant ? 'Ava: ' : 'You: '), text)
  if (assistant) row.append(label)
  row.append(copy)
  return row
}

function pendingRow(text: string): HTMLLIElement {
  const row = document.createElement('li')
  row.className = 'answer-turn answer-turn--user answer-turn--pending'
  const label = document.createElement('p')
  label.className = 'turn-label'
  label.textContent = 'You, speaking'
  const content = document.createElement('div')
  content.className = 'turn-copy'
  const copy = document.createElement('p')
  copy.textContent = text
  content.append(srLabel('You, speaking: '), copy)
  row.append(label, content)
  return row
}

function typingRow(): HTMLLIElement {
  const row = document.createElement('li')
  row.className = 'answer-turn answer-turn--assistant'
  const label = document.createElement('p')
  label.className = 'turn-label'
  label.textContent = 'Answer'
  const bubble = document.createElement('div')
  bubble.className = 'turn-copy typing-bubble'
  const dots = document.createElement('span')
  dots.className = 'typing-dots'
  dots.setAttribute('aria-hidden', 'true')
  dots.append(document.createElement('span'), document.createElement('span'), document.createElement('span'))
  const still = document.createElement('span')
  still.className = 'typing-static'
  still.setAttribute('aria-hidden', 'true')
  still.textContent = '…'
  bubble.append(dots, still, srLabel('Ava is typing'))
  row.append(label, bubble)
  return row
}

function systemNote(text: string): HTMLLIElement {
  const row = document.createElement('li')
  row.className = 'system-note'
  row.textContent = text
  return row
}

function sourcesRow(anchor: number, articles: SourceArticle[], open: boolean): HTMLLIElement {
  const row = document.createElement('li')
  row.className = 'sources-row'
  const card = document.createElement('details')
  card.className = 'sources-card'
  card.dataset.anchor = String(anchor)
  card.open = open
  const summary = document.createElement('summary')
  summary.textContent = `Based on (${articles.length})`
  card.append(summary)
  const list = document.createElement('div')
  list.className = 'sources-list'
  for (const article of articles) {
    const chip = document.createElement('a')
    chip.className = 'source-chip'
    chip.href = article.url
    chip.target = '_blank'
    chip.rel = 'noopener'
    const title = document.createElement('span')
    title.textContent = article.title
    const section = document.createElement('small')
    section.textContent = article.section
    chip.append(title, section)
    list.append(chip)
  }
  card.append(list)
  const followUps = document.createElement('div')
  followUps.className = 'follow-up-prompts'
  const followUpLabel = document.createElement('p')
  followUpLabel.textContent = 'You can also ask'
  const followUpList = document.createElement('div')
  followUpList.className = 'follow-up-list'
  for (const article of articles.slice(0, 2)) {
    const prompt = document.createElement('button')
    prompt.className = 'follow-up-chip'
    prompt.type = 'button'
    prompt.textContent = `Tell me more about ${article.title}`
    prompt.addEventListener('click', () => sendMessage(`Tell me more about "${article.title}".`))
    followUpList.append(prompt)
  }
  followUps.append(followUpLabel, followUpList)
  row.append(card, followUps)
  return row
}

function setConversationMode(active: boolean, focus = false): void {
  syncSupportViewport()
  elements.app.dataset.view = active ? 'conversation' : 'landing'
  document.documentElement.classList.toggle('support-conversation', active)
  document.body.classList.toggle('support-conversation', active)
  elements.landingPanel.hidden = active
  elements.transcript.hidden = !active
  elements.composerBar.hidden = !active
  elements.clearButton.hidden = !active
  if (focus) (active ? elements.textInput : elements.landingInput).focus()
}

function afterReplyAnchor(): number {
  return latestMessages.at(-1)?.role === 'assistant' ? latestMessages.length : latestMessages.length + 1
}

function safeArticleUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.startsWith('/') && !value.startsWith('//')) return value
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.origin === window.location.origin ? parsed.toString() : null
  } catch {
    return null
  }
}

function renderThread(): void {
  if (latestMessages.length > 0 || interimText || typing || signinAnchor !== null || ticketAnchor !== null) {
    setConversationMode(true)
  }
  const stick = isNearBottom()
  const length = latestMessages.length
  const sourceOpenState = new Map(
    [...elements.transcript.querySelectorAll<HTMLDetailsElement>('.sources-card')]
      .map((details) => [Number(details.dataset.anchor), details.open] as const)
      .filter(([anchor]) => Number.isFinite(anchor)),
  )
  const rows: Node[] = []
  const pushExtras = (index: number): void => {
    for (const note of notes) {
      if (note.anchor <= length && note.anchor === index) rows.push(systemNote(note.text))
    }
    for (const entry of sources) {
      if (entry.anchor <= length && entry.anchor === index) {
        rows.push(sourcesRow(entry.anchor, entry.articles, sourceOpenState.get(entry.anchor) ?? true))
      }
    }
    if (signinAnchor !== null && signinAnchor <= length && signinAnchor === index) {
      elements.signinFlow.hidden = false
      rows.push(elements.signinFlow)
    }
    if (ticketAnchor !== null && ticketAnchor <= length && ticketAnchor === index) {
      elements.handoffCard.hidden = false
      rows.push(elements.handoffCard)
    }
  }
  for (let index = 0; index < length; index++) {
    pushExtras(index)
    const message = latestMessages[index]!
    if (!(message.role === 'user' && hiddenTranscriptMessages.has(message.text))) {
      rows.push(messageRow(message))
    }
  }
  pushExtras(length)
  if (interimText) rows.push(pendingRow(interimText))
  if (typing) rows.push(typingRow())
  elements.transcript.replaceChildren(...rows)
  if (stick) scrollToBottom()
}

function pushNote(text: string): void {
  const last = notes[notes.length - 1]
  if (last && last.text === text && last.anchor === latestMessages.length) return
  notes.push({ anchor: latestMessages.length, text })
  renderThread()
}

function updateControls(status: VoiceStatus): void {
  let extrasFlushed = false
  if (status === 'idle') {
    for (const entry of sources) {
      if (entry.anchor > latestMessages.length) {
        entry.anchor = latestMessages.length
        extrasFlushed = true
      }
    }
    if (signinAnchor !== null && signinAnchor > latestMessages.length) {
      signinAnchor = latestMessages.length
      extrasFlushed = true
    }
  }
  const busyWithoutCall = !callActive && status !== 'idle'
  const ready = isReady()
  elements.micButton.disabled = !ready || busyWithoutCall
  elements.landingMicButton.disabled = !ready || busyWithoutCall
  for (const mic of [elements.micButton, elements.landingMicButton]) {
    mic.classList.toggle('mic-button--active', callActive)
    mic.setAttribute('aria-label', callActive ? 'Stop voice' : 'Use voice')
    mic.setAttribute('aria-pressed', String(callActive))
    mic.title = callActive ? 'Stop the voice call' : 'Talk instead of typing'
  }
  elements.muteButton.hidden = !callActive
  elements.muteButton.disabled = !ready || !callActive
  elements.clearButton.disabled = !connected
  elements.app.setAttribute('aria-busy', String(!ready))
  elements.landingInput.disabled = false
  elements.landingSubmit.disabled = !ready
  for (const task of supportTaskButtons) task.disabled = !ready
  elements.humanHelpButton.disabled = !ready
  elements.textInput.disabled = false
  elements.textSubmit.disabled = !ready
  elements.conversationHumanButton.disabled = !ready
  const nowTyping = status === 'thinking'
  if (nowTyping !== typing) {
    typing = nowTyping
    renderThread()
  } else if (extrasFlushed) {
    renderThread()
  }
}

function applySignInCardCopy(): void {
  const copy = signinReason === 'order_lookup'
    ? {
      lead: 'Sign in to check your order',
      copy: 'Use your store account — a quick code by email, no password. I’ll pull your orders up right after.',
    }
    : {
      lead: 'Sign in to continue',
      copy: 'Use your store account — a quick code by email, no password. You’ll come right back to this conversation.',
    }
  elements.signinLead.textContent = copy.lead
  elements.signinCopy.textContent = copy.copy
}

function readSignInReason(value: unknown): SignInReason | null {
  return value === 'order_lookup' || value === 'open_ticket' ? value : null
}

function showSignInCard(anchor: 'now' | 'after_reply'): void {
  setConversationMode(true)
  if (signinAnchor === null) {
    signinAnchor = anchor === 'after_reply' ? afterReplyAnchor() : latestMessages.length
  }
  applySignInCardCopy()
  elements.signinButton.disabled = false
  renderThread()
  scrollToBottom()
}

function hideSignInCard(): void {
  signinAnchor = null
  elements.signinFlow.hidden = true
  renderThread()
}

function beginStoreSignIn(): void {
  try {
    sessionStorage.setItem(SIGNIN_RESUME_KEY, activeSessionName)
  } catch {
    // Without session storage the conversation cannot resume, but sign-in
    // itself still works from a fresh session.
  }
  elements.signinButton.disabled = true
  window.location.assign('/auth/shopify/start')
}

type TurnstileApi = {
  render(container: string | HTMLElement, parameters: {
    sitekey: string
    action?: string
    size?: string
    appearance?: 'always' | 'execute' | 'interaction-only'
    callback?: (token: string) => void
  }): string
  reset(widgetId?: string): void
  getResponse(widgetId?: string): string | undefined
}

function turnstileApi(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile
}

// The session proof runs an invisible managed check once per connection;
// identity itself is the store-account sign-in, which happens on the store's
// hosted login rather than in the chat.
let sessionWidgetId: string | null = null
let pendingSessionToken: string | null = null
const sessionSitekey = elements.sessionTurnstile.dataset.sitekey ?? ''

function sendSessionProof(token: string): void {
  if (!connected) {
    pendingSessionToken = token
    return
  }
  client.sendJSON({ type: 'start_voice_session', turnstileToken: token })
}

function beginSessionProof(): void {
  if (sessionReady || !connected) return
  if (pendingSessionToken !== null) {
    const token = pendingSessionToken
    pendingSessionToken = null
    sendSessionProof(token)
    return
  }
  if (!sessionSitekey) {
    sendSessionProof('')
    return
  }
  const api = turnstileApi()
  if (!api) {
    window.setTimeout(beginSessionProof, 200)
    return
  }
  if (sessionWidgetId === null) {
    try {
      sessionWidgetId = api.render(elements.sessionTurnstile, {
        sitekey: sessionSitekey,
        action: 'voice_session',
        size: 'flexible',
        appearance: 'interaction-only',
        callback: (token) => sendSessionProof(token),
      })
    } catch {
      sessionWidgetId = null
    }
  } else {
    // A reset re-runs the check and fires the callback with a fresh token.
    api.reset(sessionWidgetId)
  }
}

const SESSION_ERROR_COPY: Record<string, string> = {
  rate_limited: 'Too many chat sessions from this connection. Wait a minute, then reload the page.',
  turnstile_not_configured: 'This chat is not fully set up yet. Please try again later.',
}

function renderTicket(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const ticket = value as { reference?: unknown; label?: unknown; status?: unknown }
  elements.handoffCategory.textContent = typeof ticket.label === 'string' ? ticket.label : 'Support ticket opened'
  elements.handoffDescription.textContent = 'A support ticket was opened under your store account. The team will follow up by email.'
  elements.handoffReference.textContent = typeof ticket.reference === 'string' ? ticket.reference : '—'
  elements.handoffStatus.textContent = typeof ticket.status === 'string' ? ticket.status : 'open'
  ticketAnchor = latestMessages.length
  setConversationMode(true)
  renderThread()
  scrollToBottom()
}

function renderCustomMessage(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const message = value as Record<string, unknown>
  if (message.type === 'voice_session_ready') {
    sessionReady = true
    elements.sessionTurnstile.hidden = true
    elements.landingStatus.textContent = ''
    updateControls(client.status)
    if (signInContinuationPending) {
      // Back from the hosted store login: resume the interrupted flow. This is
      // a machine-readable continuation, not customer copy.
      signInContinuationPending = false
      hideSignInCard()
      hiddenTranscriptMessages.add(SIGN_IN_CONTINUATION)
      setConversationMode(true)
      client.sendText(SIGN_IN_CONTINUATION)
    }
    if (focusAfterReset()) elements.landingInput.focus()
    return
  }
  if (message.type === 'voice_session_error' || message.type === 'voice_session_required') {
    sessionReady = false
    const reason = typeof message.reason === 'string' ? message.reason : ''
    const copy = SESSION_ERROR_COPY[reason] ?? 'The anti-spam check could not be completed. Reload the page to try again.'
    elements.landingStatus.textContent = copy
    if (elements.app.dataset.view === 'conversation') pushNote(copy)
    updateControls(client.status)
    return
  }
  if (message.type === 'voice_signin_required') {
    signinReason = readSignInReason(message.reason)
    showSignInCard(message.anchor === 'after_reply' ? 'after_reply' : 'now')
    return
  }
  if (message.type === 'voice_sources') {
    const articles = (Array.isArray(message.articles) ? message.articles : [])
      .flatMap((entry): SourceArticle[] => {
        if (!entry || typeof entry !== 'object') return []
        const record = entry as Record<string, unknown>
        const url = safeArticleUrl(record.url)
        return url && typeof record.title === 'string' && typeof record.section === 'string'
          ? [{ title: record.title, section: record.section, url }]
          : []
      })
      .slice(0, 3)
    if (articles.length > 0) {
      // Anchored one past the current transcript so the chips land after the
      // assistant reply this tool call belongs to.
      const anchor = afterReplyAnchor()
      const existing = sources.find((entry) => entry.anchor === anchor)
      if (existing) {
        existing.articles = [...existing.articles, ...articles]
          .filter((article, index, all) => all.findIndex((candidate) => candidate.url === article.url) === index)
          .slice(0, 3)
      } else {
        sources.push({ anchor, articles })
      }
      renderThread()
    }
    return
  }
  if (message.type === 'demo_session_cleared') {
    ticketAnchor = null
    sources = []
    elements.handoffCard.hidden = true
    hideSignInCard()
    renderThread()
    if (resetReload !== null) {
      clearTimeout(resetReload)
      resetReload = null
      reloadFreshSession()
    }
    return
  }
  if (message.type === 'voice_ticket_created') renderTicket(message.ticket)
}

client.addEventListener('connectionchange', (isConnected) => {
  connected = isConnected
  if (isConnected) {
    hasConnected = true
    elements.reconnectBanner.hidden = true
    // Connection state lives on the server connection; every (re)connect
    // starts unproven, so run the invisible session check again.
    sessionReady = false
    elements.sessionTurnstile.hidden = false
    beginSessionProof()
  } else {
    callActive = false
    sessionReady = false
    if (hasConnected) elements.reconnectBanner.hidden = false
  }
  updateControls(client.status)
})
client.addEventListener('statuschange', updateControls)
client.addEventListener('transcriptchange', (messages) => {
  latestMessages = messages
  if (messages.length > 0) setConversationMode(true)
  renderThread()
})
client.addEventListener('interimtranscript', (text) => {
  interimText = text ?? ''
  renderThread()
})
client.addEventListener('mutechange', (muted) => {
  elements.muteButton.textContent = muted ? 'Unmute' : 'Mute'
})
client.addEventListener('custommessage', renderCustomMessage)
client.addEventListener('error', (error) => {
  if (!error) return
  if (elements.app.dataset.view === 'landing') elements.landingStatus.textContent = error
  else pushNote(error)
})

async function toggleVoice(): Promise<void> {
  if (!callActive) {
    setConversationMode(true)
    await client.startCall()
    callActive = true
    pushNote('Voice on — speak naturally')
  } else {
    client.endCall()
    callActive = false
    pushNote('Voice off')
  }
  updateControls(client.status)
}

elements.micButton.addEventListener('click', toggleVoice)
elements.landingMicButton.addEventListener('click', toggleVoice)

elements.muteButton.addEventListener('click', () => client.toggleMute())

elements.signinButton.addEventListener('click', beginStoreSignIn)

elements.clearButton.addEventListener('click', () => {
  if (callActive) client.endCall()
  callActive = false
  elements.clearButton.disabled = true
  client.sendJSON({ type: 'clear_demo_session' })
  resetReload = setTimeout(reloadFreshSession, 2_000)
  latestMessages = []
  notes = []
  sources = []
  ticketAnchor = null
  elements.handoffCard.hidden = true
  hideSignInCard()
  interimText = ''
  typing = false
  elements.landingInput.value = ''
  elements.textInput.value = ''
  signinReason = null
  setConversationMode(false, true)
  renderThread()
  updateControls(client.status)
})

function sendMessage(message: string): boolean {
  if (!message || !isReady()) return false
  setConversationMode(true)
  client.sendText(message)
  return true
}

function focusSupportRequest(): void {
  if (!isReady()) return
  elements.landingInput.placeholder = 'Briefly describe what you need help with'
  elements.landingStatus.textContent = 'Describe the issue first. Ava will ask you to sign in only if a private request is needed.'
  elements.landingInput.focus()
}

function requestHumanHelpForConversation(): void {
  const latestCustomerMessage = [...latestMessages].reverse().find((message) => message.role === 'user')?.text.trim()
  if (!latestCustomerMessage) {
    elements.textInput.placeholder = 'Briefly describe what you need help with'
    elements.textInput.focus()
    return
  }
  sendMessage(`${HUMAN_HELP_MESSAGE} My issue is: ${latestCustomerMessage}`)
}

elements.landingForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const message = elements.landingInput.value.trim()
  if (!message) return
  if (!isReady()) {
    elements.landingStatus.textContent = 'Preparing secure chat…'
    return
  }
  elements.landingInput.blur()
  if (sendMessage(message)) elements.landingInput.value = ''
})

elements.humanHelpButton.addEventListener('click', () => {
  focusSupportRequest()
})

for (const task of supportTaskButtons) {
  task.addEventListener('click', () => {
    const message = task.dataset.supportMessage
    if (message) sendMessage(message)
  })
}

elements.conversationHumanButton.addEventListener('click', () => {
  requestHumanHelpForConversation()
})

elements.textForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const message = elements.textInput.value.trim()
  if (!message) return
  if (sendMessage(message)) elements.textInput.value = ''
})

window.addEventListener('beforeunload', () => {
  viewportListenerAbort.abort()
  if (callActive) client.endCall()
  client.disconnect()
})

updateControls(client.status)
setConversationMode(false)
client.connect()
