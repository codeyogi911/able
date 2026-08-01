import { VoiceClient, type TranscriptMessage, type VoiceStatus } from '@cloudflare/voice/client'
import './demo.css'
import { contactContinuationMessage } from './contact'
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
  contactFlow: required<HTMLLIElement>('#contact-flow'),
  contactForm: required<HTMLFormElement>('#contact-form'),
  contactName: required<HTMLInputElement>('#contact-name'),
  contactEmail: required<HTMLInputElement>('#contact-email'),
  contactSubmit: required<HTMLButtonElement>('#contact-submit'),
  contactFeedback: required<HTMLElement>('#contact-feedback'),
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
  verifyCard: required<HTMLLIElement>('#verify-card'),
  verifyEmail: required<HTMLElement>('#verify-email'),
  verifyTurnstile: required<HTMLElement>('#verify-turnstile'),
  verifySend: required<HTMLButtonElement>('#verify-send'),
  verifyForm: required<HTMLFormElement>('#verify-form'),
  verifyCode: required<HTMLInputElement>('#verify-code'),
  verifySubmit: required<HTMLButtonElement>('#verify-submit'),
  verifyFeedback: required<HTMLElement>('#verify-feedback'),
}

const SESSION_KEY = 'morrow-voice-support-session'
const RESET_FOCUS_KEY = 'morrow-voice-support-reset-focus'

function sessionName(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY)
    if (existing) return existing
    const created = `voice-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
    sessionStorage.setItem(SESSION_KEY, created)
    return created
  } catch {
    return `voice-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
  }
}

const client = new VoiceClient({
  agent: 'MorrowDeskAgent',
  name: sessionName(),
  preferredFormat: 'mp3',
})

let connected = false
let hasConnected = false
let callActive = false
let sessionReady = false
let contactReady = false
let contactPending = false

type SourceArticle = { title: string; section: string; url: string }

let latestMessages: TranscriptMessage[] = []
let notes: { anchor: number; text: string }[] = []
let sources: { anchor: number; articles: SourceArticle[] }[] = []
let ticketAnchor: number | null = null
let contactAnchor: number | null = null
let verifyAnchor: number | null = null
let verifyResendAt = 0
let verifyWidgetId: string | null = null
let verifyCountdown: ReturnType<typeof setInterval> | null = null
let interimText = ''
let typing = false
let contactFocusPending = false
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
    sessionStorage.removeItem(SESSION_KEY)
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
  summary.textContent = `Show sources (${articles.length})`
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
  if (latestMessages.length > 0 || interimText || typing || contactAnchor !== null || verifyAnchor !== null || ticketAnchor !== null) {
    setConversationMode(true)
  }
  const stick = isNearBottom()
  const length = latestMessages.length
  const openSourceAnchors = new Set(
    [...elements.transcript.querySelectorAll<HTMLDetailsElement>('.sources-card[open]')]
      .map((details) => Number(details.dataset.anchor))
      .filter(Number.isFinite),
  )
  const rows: Node[] = []
  const pushExtras = (index: number): void => {
    for (const note of notes) {
      if (note.anchor <= length && note.anchor === index) rows.push(systemNote(note.text))
    }
    for (const entry of sources) {
      if (entry.anchor <= length && entry.anchor === index) {
        rows.push(sourcesRow(entry.anchor, entry.articles, openSourceAnchors.has(entry.anchor)))
      }
    }
    if (contactAnchor !== null && contactAnchor <= length && contactAnchor === index) {
      elements.contactFlow.hidden = false
      rows.push(elements.contactFlow)
    }
    if (verifyAnchor !== null && verifyAnchor <= length && verifyAnchor === index) {
      elements.verifyCard.hidden = false
      rows.push(elements.verifyCard)
    }
    if (ticketAnchor !== null && ticketAnchor <= length && ticketAnchor === index) {
      elements.handoffCard.hidden = false
      rows.push(elements.handoffCard)
    }
  }
  for (let index = 0; index < length; index++) {
    pushExtras(index)
    rows.push(messageRow(latestMessages[index]!))
  }
  pushExtras(length)
  if (interimText) rows.push(pendingRow(interimText))
  if (typing) rows.push(typingRow())
  elements.transcript.replaceChildren(...rows)
  if (contactFocusPending && elements.contactFlow.isConnected) {
    contactFocusPending = false
    elements.contactName.focus()
  }
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
    if (contactAnchor !== null && contactAnchor > latestMessages.length) {
      contactAnchor = latestMessages.length
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

function updateContactCard(): void {
  elements.contactSubmit.disabled = !connected || contactPending
  elements.contactName.disabled = contactPending
  elements.contactEmail.disabled = contactPending
  elements.contactSubmit.textContent = contactPending ? 'Saving…' : 'Continue'
}

function showContactCard(anchor: 'now' | 'after_reply'): void {
  setConversationMode(true)
  if (contactAnchor === null) {
    contactAnchor = anchor === 'after_reply' ? afterReplyAnchor() : latestMessages.length
    contactFocusPending = true
  }
  updateContactCard()
  renderThread()
  scrollToBottom()
}

function hideContactCard(): void {
  contactAnchor = null
  contactFocusPending = false
  elements.contactFlow.hidden = true
  elements.contactFeedback.textContent = 'Used only for the support action you requested.'
  renderThread()
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

// The session proof runs an invisible managed check once per connection; the
// contact card itself has no widget, so mid-conversation identity stays light.
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

// The contact widget was removed; the verification card still renders its own
// explicit widget the first time it is shown (dormant OTP flow).
function ensureVerifyTurnstile(): void {
  if (verifyWidgetId !== null) return
  const api = turnstileApi()
  const sitekey = elements.verifyTurnstile.dataset.sitekey ?? ''
  if (!api || !sitekey) return
  try {
    verifyWidgetId = api.render(elements.verifyTurnstile, { sitekey, action: 'voice_verify', size: 'flexible' })
  } catch {
    verifyWidgetId = null
  }
}

function verifyTurnstileToken(): string {
  if (verifyWidgetId === null) return ''
  return turnstileApi()?.getResponse(verifyWidgetId) ?? ''
}

function resetVerifyTurnstile(): void {
  if (verifyWidgetId !== null) turnstileApi()?.reset(verifyWidgetId)
}

function stopVerifyCountdown(): void {
  if (verifyCountdown !== null) {
    clearInterval(verifyCountdown)
    verifyCountdown = null
  }
}

function updateVerifySend(): void {
  const remaining = Math.ceil((verifyResendAt - Date.now()) / 1_000)
  if (remaining > 0) {
    elements.verifySend.disabled = true
    elements.verifySend.textContent = `Resend in ${remaining}s`
    return
  }
  stopVerifyCountdown()
  elements.verifySend.disabled = !connected
  elements.verifySend.textContent = verifyResendAt > 0 ? 'Resend code' : 'Email me a code'
}

function startVerifyCountdown(): void {
  stopVerifyCountdown()
  updateVerifySend()
  verifyCountdown = setInterval(updateVerifySend, 1_000)
}

function showVerifyCard(): void {
  setConversationMode(true)
  if (verifyAnchor === null) verifyAnchor = latestMessages.length
  ensureVerifyTurnstile()
  updateVerifySend()
  renderThread()
  scrollToBottom()
}

function hideVerifyCard(): void {
  verifyAnchor = null
  elements.verifyCard.hidden = true
  elements.verifyForm.hidden = true
  elements.verifyCode.value = ''
  elements.verifyFeedback.textContent = ''
  stopVerifyCountdown()
  renderThread()
}

const ERROR_COPY: Record<string, string> = {
  invalid_contact: 'Check your name and email, then try again.',
  session_required: 'The chat is still finishing its anti-spam check. Try again in a moment.',
  rate_limited: 'Too many attempts right now. Wait a minute and try again.',
  unavailable: 'That could not be completed right now. Try again.',
}

const SESSION_ERROR_COPY: Record<string, string> = {
  rate_limited: 'Too many chat sessions from this connection. Wait a minute, then reload the page.',
  turnstile_not_configured: 'This chat is not fully set up yet. Please try again later.',
}

const VERIFY_ERROR_COPY: Record<string, string> = {
  contact_required: 'Share your email first, then request a code.',
  cooldown: 'A code was just sent. Wait a minute before requesting another.',
  request_in_progress: 'A code request is already in progress.',
  rate_limited: 'Too many attempts right now. Wait a minute and try again.',
  turnstile_required: 'Complete the anti-spam check and try again.',
  turnstile_not_configured: 'Verification is not fully set up yet. Please try again later.',
  email_not_configured: 'Verification email is not ready yet. Please try again later.',
  invalid_or_expired_code: 'That code is incorrect or expired. Check the email and try again.',
  unavailable: 'That could not be completed right now. Try again.',
}

function renderTicket(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const ticket = value as { reference?: unknown; label?: unknown; status?: unknown }
  elements.handoffCategory.textContent = typeof ticket.label === 'string' ? ticket.label : 'Support ticket opened'
  elements.handoffDescription.textContent = 'A support ticket was opened for the email you shared. The team will follow up there.'
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
  if (message.type === 'voice_contact_set') {
    contactReady = true
    contactPending = false
    hideContactCard()
    updateContactCard()
    updateControls(client.status)
    const contact = message.contact as { email?: unknown } | undefined
    const email = typeof contact?.email === 'string' ? contact.email : 'your email'
    pushNote(`We’ll use ${email} for this support action`)
    // Mid-conversation the card interrupted a flow Ava offered to continue;
    // a visible, intent-specific confirmation hands the exact flow back to her.
    const continuation = contactContinuationMessage(message.continuation)
    if (latestMessages.length > 0 && continuation) client.sendText(continuation)
    else elements.textInput.focus()
    return
  }
  if (message.type === 'voice_contact_error') {
    contactPending = false
    const reason = typeof message.reason === 'string' ? message.reason : ''
    elements.contactFeedback.textContent = ERROR_COPY[reason] ?? 'That could not be completed right now. Try again.'
    updateContactCard()
    return
  }
  if (message.type === 'voice_contact_required') {
    contactReady = false
    contactPending = false
    showContactCard(message.anchor === 'after_reply' ? 'after_reply' : 'now')
    return
  }
  if (message.type === 'voice_pending_action_error') {
    pushNote('Your contact details were saved, but the ticket could not be opened. Send a message to try again.')
    return
  }
  if (message.type === 'voice_identity_cleared') {
    contactReady = false
    contactPending = false
    hideContactCard()
    hideVerifyCard()
    elements.contactName.value = ''
    elements.contactEmail.value = ''
    updateControls(client.status)
    if (resetReload !== null) {
      clearTimeout(resetReload)
      resetReload = null
      reloadFreshSession()
    }
    return
  }
  if (message.type === 'voice_verification_needed') {
    showVerifyCard()
    return
  }
  if (message.type === 'voice_verification_sent') {
    verifyResendAt = Date.now() + 60_000
    resetVerifyTurnstile()
    showVerifyCard()
    elements.verifyForm.hidden = false
    elements.verifySubmit.disabled = false
    const hint = typeof message.emailHint === 'string' ? message.emailHint : 'your email'
    elements.verifyEmail.textContent = hint
    elements.verifyFeedback.textContent = `Code sent to ${hint}. It expires in 10 minutes.`
    startVerifyCountdown()
    elements.verifyCode.focus()
    return
  }
  if (message.type === 'voice_verified') {
    hideVerifyCard()
    const email = typeof message.email === 'string' ? message.email : 'your email'
    pushNote(`Email verified — ${email}`)
    return
  }
  if (message.type === 'voice_verification_error') {
    resetVerifyTurnstile()
    showVerifyCard()
    elements.verifySubmit.disabled = false
    const reason = typeof message.reason === 'string' ? message.reason : ''
    elements.verifyFeedback.textContent = VERIFY_ERROR_COPY[reason] ?? 'That could not be completed right now. Try again.'
    updateVerifySend()
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
    hideContactCard()
    renderThread()
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
    contactReady = false
    contactPending = false
    verifyResendAt = 0
    hideContactCard()
    hideVerifyCard()
    if (hasConnected) elements.reconnectBanner.hidden = false
  }
  updateContactCard()
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

elements.contactForm.addEventListener('submit', (event) => {
  event.preventDefault()
  if (!elements.contactForm.reportValidity() || !connected) return
  contactPending = true
  elements.contactFeedback.textContent = 'Saving your contact details…'
  client.sendJSON({
    type: 'set_voice_contact',
    name: elements.contactName.value.trim(),
    email: elements.contactEmail.value.trim(),
  })
  updateContactCard()
})

elements.muteButton.addEventListener('click', () => client.toggleMute())

elements.verifySend.addEventListener('click', () => {
  if (!connected || Date.now() < verifyResendAt) return
  elements.verifySend.disabled = true
  elements.verifyFeedback.textContent = 'Sending a code to your email…'
  client.sendJSON({ type: 'request_voice_verification', turnstileToken: verifyTurnstileToken() })
})

elements.verifyForm.addEventListener('submit', (event) => {
  event.preventDefault()
  if (!elements.verifyForm.reportValidity() || !connected) return
  elements.verifySubmit.disabled = true
  elements.verifyFeedback.textContent = 'Checking the code…'
  client.sendJSON({ type: 'verify_voice_code', code: elements.verifyCode.value.trim() })
})

elements.clearButton.addEventListener('click', () => {
  if (callActive) client.endCall()
  callActive = false
  elements.clearButton.disabled = true
  client.sendJSON({ type: 'clear_voice_identity' })
  resetReload = setTimeout(reloadFreshSession, 2_000)
  latestMessages = []
  notes = []
  sources = []
  ticketAnchor = null
  elements.handoffCard.hidden = true
  hideContactCard()
  hideVerifyCard()
  interimText = ''
  typing = false
  elements.landingInput.value = ''
  elements.textInput.value = ''
  elements.contactName.value = ''
  elements.contactEmail.value = ''
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

elements.landingForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const message = elements.landingInput.value.trim()
  if (!message) return
  if (!isReady()) {
    elements.landingStatus.textContent = 'Loading help…'
    return
  }
  elements.landingInput.blur()
  if (sendMessage(message)) elements.landingInput.value = ''
})

elements.humanHelpButton.addEventListener('click', () => {
  sendMessage(HUMAN_HELP_MESSAGE)
})

elements.conversationHumanButton.addEventListener('click', () => {
  sendMessage(HUMAN_HELP_MESSAGE)
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

updateContactCard()
updateControls(client.status)
setConversationMode(false)
client.connect()
