import { VoiceClient, type TranscriptMessage, type VoiceStatus } from '@cloudflare/voice/client'
import {
  ArrowUp,
  BookOpenText,
  ChevronDown,
  ChevronRight,
  Copy,
  FileSearch,
  Headphones,
  Mic,
  PackageSearch,
  Plus,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Truck,
  UserRound,
  Wrench,
  createIcons,
} from 'lucide'
import './demo.css'
import { renderStreamingMarkdown } from '../ui/markdown-client'
import { SIGN_IN_CONTINUATION } from './contact'
import { HUMAN_HELP_MESSAGE } from './escalation'
import { AssistantPlaybackGuard, PlaybackAwareVoiceTransport } from './playback-guard'
import { mergeConversationHistory } from './conversation-history'

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
  landingInput: required<HTMLTextAreaElement>('#landing-input'),
  landingSubmit: required<HTMLButtonElement>('#landing-submit'),
  landingMicButton: required<HTMLButtonElement>('#landing-mic-button'),
  humanHelpButton: required<HTMLButtonElement>('#human-help-button'),
  conversationHumanButton: required<HTMLButtonElement>('#conversation-human-button'),
  landingStatusCopy: required<HTMLElement>('#landing-status-copy'),
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
  textInput: required<HTMLTextAreaElement>('#text-input'),
  textSubmit: required<HTMLButtonElement>('#text-form button[type="submit"]'),
  handoffCard: required<HTMLLIElement>('#handoff-card'),
  handoffCategory: required<HTMLElement>('#handoff-category'),
  handoffDescription: required<HTMLElement>('#handoff-description'),
  handoffReference: required<HTMLElement>('#handoff-reference'),
  handoffStatus: required<HTMLElement>('#handoff-status'),
  voiceState: required<HTMLElement>('#voice-state'),
  voiceStateCopy: required<HTMLElement>('#voice-state-copy'),
  conversationStatus: required<HTMLElement>('#conversation-status'),
}

createIcons({
  icons: {
    ArrowUp,
    BookOpenText,
    ChevronDown,
    ChevronRight,
    Copy,
    FileSearch,
    Headphones,
    Mic,
    PackageSearch,
    Plus,
    Sparkles,
    ThumbsDown,
    ThumbsUp,
    Truck,
    UserRound,
    Wrench,
  },
  attrs: { 'aria-hidden': 'true', 'stroke-width': 2 },
})

const supportTaskButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-support-message]')]
const voiceInputAvailable = elements.app.dataset.voiceInput !== 'unavailable'

const RESET_FOCUS_KEY = 'able-voice-support-reset-focus'

const SIGNIN_RESUME_KEY = 'able-signin-resume-session'
const returnedFromSignIn = new URLSearchParams(window.location.search).has('signed_in')

function sessionName(): string {
  // Help always opens at its landing page. A browser refresh is a new visit,
  // not an accidental restoration of a previous transcript — with one
  // exception: returning from the hosted store sign-in resumes the exact
  // conversation that requested it.
  if (returnedFromSignIn) {
    const serverResume = elements.app.dataset.resumeSession
    if (serverResume && /^voice-[a-z0-9]{20}$/.test(serverResume)) return serverResume
    try {
      const stored = sessionStorage.getItem(SIGNIN_RESUME_KEY)
      if (stored && /^voice-[a-z0-9]{20}$/.test(stored)) return stored
    } catch {
      // Fall through to a fresh session.
    }
  }
  return `voice-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
}

const activeSessionName = sessionName()
if (returnedFromSignIn) history.replaceState(null, '', window.location.pathname)

let assistantMicPaused = false
let guardAppliedMute = false
let client: VoiceClient
const playbackGuard = new AssistantPlaybackGuard((suppressed) => {
  assistantMicPaused = suppressed
  if (suppressed) {
    guardAppliedMute = !client.isMuted
    if (guardAppliedMute) client.toggleMute()
  } else {
    if (guardAppliedMute && client.isMuted) client.toggleMute()
    guardAppliedMute = false
  }
  updateControls(client.status)
})
const voiceTransport = new PlaybackAwareVoiceTransport({
  agent: 'AbleDeskAgent',
  name: activeSessionName,
}, playbackGuard)

client = new VoiceClient({
  agent: 'AbleDeskAgent',
  name: activeSessionName,
  transport: voiceTransport,
  preferredFormat: 'pcm16',
  // Customer audio is intentionally half-duplex. The playback guard owns
  // turn-taking, so speaker echo must never trigger the client's barge-in.
  interruptThreshold: Number.POSITIVE_INFINITY,
})

let connected = false
let hasConnected = false
let callActive = false
let sessionReady = false
let signInContinuationPending = returnedFromSignIn

type SignInReason = 'order_lookup' | 'open_ticket'
let signinReason: SignInReason | null = null

type SourceArticle = { title: string; section: string; url: string }
type ProductCard = {
  handle: string
  title: string
  availableForSale: boolean
  price: string
  url: string | null
  image: { url: string; altText: string } | null
}

let latestMessages: TranscriptMessage[] = []
let restoredMessages: TranscriptMessage[] = []
const hiddenTranscriptMessages = new Set<string>()
let notes: { anchor: number; text: string }[] = []
let sources: { anchor: number; articles: SourceArticle[] }[] = []
let products: { anchor: number; items: ProductCard[] }[] = []
let ticketAnchor: number | null = null
let signinAnchor: number | null = null
let interimText = ''
let typing = false
let queuedMessage: string | null = null
let queuedMessageSent = false
let awaitingReply = false
let replyFailed = false
let resetReload: ReturnType<typeof setTimeout> | null = null
let connectionDelayTimer: ReturnType<typeof setTimeout> | null = null
let replyDelayTimer: ReturnType<typeof setTimeout> | null = null
let replyTimeoutTimer: ReturnType<typeof setTimeout> | null = null
let lastAnnouncedStatus = ''
let previousClientStatus: VoiceStatus = client.status
let pendingProductRevealAnchor: number | null = null
const feedbackByTurn = new Map<number, 'helpful' | 'not_helpful'>()
const feedbackPending = new Set<number>()
let pendingFeedbackFocus: { assistantTurn: number; rating: 'helpful' | 'not_helpful' } | null = null

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

type ConnectionStage = 'connecting' | 'verifying' | 'ready' | 'reconnecting' | 'error'

function setConnectionStage(stage: ConnectionStage, copy: string): void {
  elements.app.dataset.connection = stage
  elements.landingStatusCopy.textContent = copy
}

function clearConnectionDelay(): void {
  if (connectionDelayTimer === null) return
  clearTimeout(connectionDelayTimer)
  connectionDelayTimer = null
}

function scheduleConnectionDelay(): void {
  clearConnectionDelay()
  connectionDelayTimer = setTimeout(() => {
    connectionDelayTimer = null
    if (isReady()) return
    setConnectionStage(
      hasConnected ? 'verifying' : 'connecting',
      'Still connecting — you can ask now. Your question will send automatically.',
    )
  }, 1_200)
}

function clearReplyWait(): void {
  awaitingReply = false
  if (replyDelayTimer !== null) clearTimeout(replyDelayTimer)
  if (replyTimeoutTimer !== null) clearTimeout(replyTimeoutTimer)
  replyDelayTimer = null
  replyTimeoutTimer = null
}

function beginReplyWait(): void {
  clearReplyWait()
  replyFailed = false
  awaitingReply = true
  replyDelayTimer = setTimeout(() => {
    replyDelayTimer = null
    if (awaitingReply) pushNote('Ava is checking this now — some answers take a little longer.')
  }, 6_000)
  replyTimeoutTimer = setTimeout(() => {
    replyTimeoutTimer = null
    if (awaitingReply) pushNote('This is taking longer than usual. You can try again or contact support.')
  }, 18_000)
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

function announceStatus(text: string): void {
  if (!text || text === lastAnnouncedStatus) return
  lastAnnouncedStatus = text
  elements.conversationStatus.textContent = text
}

function resizeComposerInput(input: HTMLTextAreaElement): void {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 112)}px`
}

function resetComposerInput(input: HTMLTextAreaElement): void {
  input.value = ''
  resizeComposerInput(input)
}

function answerActions(message: TranscriptMessage, assistantTurn: number): HTMLElement {
  const actions = document.createElement('div')
  actions.className = 'message-actions'
  actions.setAttribute('aria-label', 'Answer actions')

  for (const [rating, label, icon] of [
    ['helpful', 'Helpful answer', 'thumbs-up'],
    ['not_helpful', 'Not helpful', 'thumbs-down'],
  ] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'message-action'
    button.dataset.assistantTurn = String(assistantTurn)
    button.dataset.rating = rating
    button.setAttribute('aria-label', label)
    button.setAttribute('aria-pressed', String(feedbackByTurn.get(assistantTurn) === rating))
    button.disabled = feedbackPending.has(assistantTurn)
    const iconNode = document.createElement('i')
    iconNode.setAttribute('data-lucide', icon)
    iconNode.setAttribute('aria-hidden', 'true')
    button.append(iconNode)
    button.addEventListener('click', () => {
      feedbackPending.add(assistantTurn)
      pendingFeedbackFocus = { assistantTurn, rating }
      client.sendJSON({ type: 'voice_feedback', assistantTurn, rating })
      renderThread()
    })
    actions.append(button)
  }

  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'message-action'
  copy.setAttribute('aria-label', 'Copy answer')
  const copyIcon = document.createElement('i')
  copyIcon.setAttribute('data-lucide', 'copy')
  copyIcon.setAttribute('aria-hidden', 'true')
  copy.append(copyIcon)
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(message.text)
      announceStatus('Answer copied.')
    } catch {
      announceStatus('The answer could not be copied. Select the text and copy it manually.')
    }
  })
  actions.append(copy)
  return actions
}

function messageRow(message: TranscriptMessage, index: number): HTMLLIElement {
  const assistant = message.role === 'assistant'
  const row = document.createElement('li')
  row.className = `answer-turn answer-turn--${assistant ? 'assistant' : 'user'}`
  const label = document.createElement('p')
  label.className = 'turn-label'
  label.textContent = assistant ? 'Ava' : 'You'
  const copy = document.createElement('div')
  copy.className = 'turn-copy'
  const text = document.createElement(assistant ? 'div' : 'p')
  if (assistant) renderStreamingMarkdown(text, message.text)
  else text.textContent = message.text
  copy.append(srLabel(assistant ? 'Ava: ' : 'You: '), text)
  const answerComplete = assistant && (index < latestMessages.length - 1 || (client.status === 'idle' && !awaitingReply))
  if (answerComplete) copy.append(answerActions(message, index))
  row.append(label, copy)
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

function queuedMessageRow(text: string): HTMLLIElement {
  const row = document.createElement('li')
  row.className = 'answer-turn answer-turn--user answer-turn--pending'
  const label = document.createElement('p')
  label.className = 'turn-label'
  label.textContent = 'You'
  const content = document.createElement('div')
  content.className = 'turn-copy'
  const copy = document.createElement('p')
  copy.textContent = text
  content.append(srLabel('You: '), copy)
  row.append(label, content)
  return row
}

function typingRow(activity = 'Ava is working on this…'): HTMLLIElement {
  const row = document.createElement('li')
  row.className = 'answer-turn answer-turn--assistant'
  const label = document.createElement('p')
  label.className = 'turn-label'
  label.textContent = 'Ava'
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
  const activityCopy = document.createElement('span')
  activityCopy.className = 'typing-copy'
  activityCopy.setAttribute('aria-hidden', 'true')
  activityCopy.textContent = activity
  bubble.append(dots, still, activityCopy, srLabel(activity))
  row.append(label, bubble)
  return row
}

function systemNote(text: string): HTMLLIElement {
  const row = document.createElement('li')
  row.className = 'system-note'
  row.textContent = text
  return row
}

function sourcesRow(anchor: number, articles: SourceArticle[], open: boolean, showFollowUps: boolean): HTMLLIElement {
  const row = document.createElement('li')
  row.className = 'sources-row'
  const card = document.createElement('details')
  card.className = 'sources-card'
  card.dataset.anchor = String(anchor)
  card.open = open
  const summary = document.createElement('summary')
  summary.textContent = `${articles.length} help-centre ${articles.length === 1 ? 'source' : 'sources'}`
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
  row.append(card)
  if (showFollowUps) row.append(followUps)
  return row
}

function productsRow(anchor: number, items: ProductCard[]): HTMLLIElement {
  const row = document.createElement('li')
  row.className = 'products-row'
  row.dataset.anchor = String(anchor)
  const list = document.createElement('ul')
  list.className = 'product-results'
  list.setAttribute('aria-label', 'Products from the storefront')
  for (const product of items) {
    const item = document.createElement('li')
    item.className = 'product-result-item'
    const card = document.createElement(product.url ? 'a' : 'article')
    card.className = 'product-result'
    if (card instanceof HTMLAnchorElement && product.url) {
      card.href = product.url
      card.target = '_blank'
      card.rel = 'noopener'
    }
    if (product.image) {
      const media = document.createElement('span')
      media.className = 'product-result-media'
      const image = document.createElement('img')
      image.src = product.image.url
      image.alt = product.image.altText
      image.width = 480
      image.height = 360
      image.loading = 'lazy'
      image.decoding = 'async'
      media.append(image)
      card.append(media)
    }
    const copy = document.createElement('span')
    copy.className = 'product-result-copy'
    const title = document.createElement('strong')
    title.textContent = product.title
    const price = document.createElement('span')
    price.textContent = product.price
    const availability = document.createElement('small')
    availability.className = `product-availability ${product.availableForSale ? 'product-availability--available' : ''}`
    availability.textContent = product.availableForSale ? 'Available now' : 'Currently unavailable'
    copy.append(title, price, availability)
    if (product.url) {
      const action = document.createElement('span')
      action.className = 'product-action'
      action.textContent = 'View product ↗'
      copy.append(action)
    }
    card.append(copy)
    item.append(card)
    list.append(item)
  }
  const followUps = document.createElement('div')
  followUps.className = 'product-follow-ups'
  followUps.setAttribute('aria-label', 'Continue exploring products')
  const prompts: Array<[string, string]> = [
    ['Compare these products', 'Compare these products for me.'],
    ['Best for a beginner?', 'Which of these is easiest for a beginner?'],
    items.some((product) => product.price.includes('₹'))
      ? ['Options under ₹30,000', 'Show me suitable options under ₹30,000.']
      : ['Best-value option', 'Which of these is the best value?'],
  ]
  for (const [label, prompt] of prompts) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'follow-up-chip'
    button.textContent = label
    button.addEventListener('click', () => sendMessage(prompt))
    followUps.append(button)
  }
  row.append(list, followUps)
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
    for (const entry of products) {
      if (entry.anchor <= length && entry.anchor === index) rows.push(productsRow(entry.anchor, entry.items))
    }
    for (const entry of sources) {
      if (entry.anchor <= length && entry.anchor === index) {
        const hasProductResults = products.some((productEntry) => productEntry.anchor === entry.anchor)
        rows.push(sourcesRow(
          entry.anchor,
          entry.articles,
          sourceOpenState.get(entry.anchor) ?? false,
          entry.anchor === length && !hasProductResults,
        ))
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
      rows.push(messageRow(message, index))
    }
  }
  pushExtras(length)
  if (interimText) rows.push(pendingRow(interimText))
  if (queuedMessage !== null && !latestMessages.some((message) => message.role === 'user' && message.text === queuedMessage)) {
    rows.push(queuedMessageRow(queuedMessage))
  }
  if (queuedMessage !== null && !queuedMessageSent) rows.push(typingRow('Connecting securely…'))
  else if (typing) rows.push(typingRow())
  elements.transcript.replaceChildren(...rows)
  createIcons({
    icons: { Copy, ThumbsDown, ThumbsUp },
    attrs: { 'aria-hidden': 'true', 'stroke-width': 2 },
  })
  if (pendingFeedbackFocus !== null) {
    const { assistantTurn, rating } = pendingFeedbackFocus
    const selector = `.message-action[data-assistant-turn="${assistantTurn}"][data-rating="${rating}"]`
    const feedbackButton = elements.transcript.querySelector<HTMLButtonElement>(selector)
    if (feedbackButton && !feedbackButton.disabled) {
      pendingFeedbackFocus = null
      feedbackButton.focus({ preventScroll: true })
    }
  }
  if (pendingProductRevealAnchor !== null) {
    const productRow = elements.transcript.querySelector<HTMLElement>(`.products-row[data-anchor="${pendingProductRevealAnchor}"]`)
    if (productRow) {
      pendingProductRevealAnchor = null
      requestAnimationFrame(() => {
        const threadBox = elements.thread.getBoundingClientRect()
        const rowTop = productRow.getBoundingClientRect().top - threadBox.top + elements.thread.scrollTop
        elements.thread.scrollTo({ top: Math.max(0, rowTop - 250), behavior: 'auto' })
      })
      return
    }
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
    if (signinAnchor !== null && signinAnchor > latestMessages.length) {
      signinAnchor = latestMessages.length
      extrasFlushed = true
    }
  }
  const busyWithoutCall = !callActive && status !== 'idle'
  const ready = isReady()
  const canAcceptMessage = queuedMessage === null
  elements.micButton.disabled = !voiceInputAvailable || !ready || busyWithoutCall
  elements.landingMicButton.disabled = !voiceInputAvailable || !ready || busyWithoutCall
  for (const mic of [elements.micButton, elements.landingMicButton]) {
    mic.classList.toggle('mic-button--active', callActive)
    mic.setAttribute('aria-label', callActive ? 'Stop voice' : voiceInputAvailable ? 'Use voice' : 'Voice requires a deployed preview')
    mic.setAttribute('aria-pressed', String(callActive))
    mic.title = callActive ? 'Stop the voice call' : voiceInputAvailable ? 'Talk instead of typing' : 'Streaming voice is available on deployed Workers'
  }
  elements.muteButton.hidden = !callActive
  elements.muteButton.disabled = !ready || !callActive || assistantMicPaused
  elements.muteButton.textContent = assistantMicPaused ? 'Mic paused' : client.isMuted ? 'Unmute' : 'Mute'
  elements.clearButton.disabled = false
  elements.transcript.setAttribute('aria-busy', String(awaitingReply || status === 'thinking'))
  elements.landingInput.disabled = false
  elements.landingSubmit.disabled = !canAcceptMessage || elements.landingInput.value.trim() === ''
  for (const task of supportTaskButtons) task.disabled = !canAcceptMessage
  elements.humanHelpButton.disabled = false
  elements.textInput.disabled = false
  elements.textSubmit.disabled = !canAcceptMessage || elements.textInput.value.trim() === ''
  elements.conversationHumanButton.disabled = !canAcceptMessage
  elements.app.dataset.voiceState = callActive ? assistantMicPaused ? 'speaking' : status : 'off'
  elements.voiceState.hidden = !callActive
  if (callActive) {
    const stateCopy = assistantMicPaused
      ? 'Ava is speaking · mic paused'
      : status === 'thinking'
      ? 'Ava is thinking'
      : status === 'speaking'
        ? 'Ava is speaking'
        : status === 'listening'
          ? 'Listening…'
          : 'Voice is on'
    elements.voiceStateCopy.textContent = stateCopy
    announceStatus(stateCopy)
  }
  if (status === 'idle' && previousClientStatus !== 'idle') {
    const latestReply = [...latestMessages].reverse().find((message) => message.role === 'assistant')?.text.trim()
    if (latestReply) announceStatus(`Ava: ${latestReply}`)
  }
  previousClientStatus = status
  const nowTyping = !replyFailed && (status === 'thinking' || awaitingReply)
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
  window.location.assign(`/auth/shopify/start?support_session=${encodeURIComponent(activeSessionName)}`)
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

function flushQueuedMessage(): void {
  if (!isReady() || queuedMessage === null || queuedMessageSent) return
  queuedMessageSent = true
  beginReplyWait()
  client.sendText(queuedMessage)
  renderThread()
  updateControls(client.status)
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
    clearConnectionDelay()
    setConnectionStage('ready', queuedMessage === null ? 'Ava is ready.' : 'Ava is ready — sending your question…')
    elements.sessionTurnstile.hidden = true
    updateControls(client.status)
    flushQueuedMessage()
    if (signInContinuationPending) {
      // Back from the hosted store login: resume the interrupted flow. This is
      // a machine-readable continuation, not customer copy.
      signInContinuationPending = false
      try {
        sessionStorage.removeItem(SIGNIN_RESUME_KEY)
      } catch {
        // The server-issued one-use resume still completed the hand-off.
      }
      delete elements.app.dataset.resumeSession
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
    clearConnectionDelay()
    const reason = typeof message.reason === 'string' ? message.reason : ''
    const copy = SESSION_ERROR_COPY[reason] ?? 'The anti-spam check could not be completed. Reload the page to try again.'
    setConnectionStage('error', copy)
    if (elements.app.dataset.view === 'conversation') pushNote(copy)
    updateControls(client.status)
    return
  }
  if (message.type === 'voice_history') {
    const now = Date.now()
    restoredMessages = (Array.isArray(message.messages) ? message.messages : [])
      .flatMap((entry, index): TranscriptMessage[] => {
        if (!entry || typeof entry !== 'object') return []
        const value = entry as Record<string, unknown>
        if ((value.role !== 'user' && value.role !== 'assistant') || typeof value.text !== 'string') return []
        const text = value.text.trim()
        if (!text || text === SIGN_IN_CONTINUATION) return []
        return [{ role: value.role, text, timestamp: now - 80 + index }]
      })
      .slice(-80)
    latestMessages = mergeConversationHistory(restoredMessages, client.transcript)
    if (latestMessages.length > 0) setConversationMode(true)
    renderThread()
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
  if (message.type === 'voice_products') {
    const items = (Array.isArray(message.products) ? message.products : [])
      .flatMap((entry): ProductCard[] => {
        if (!entry || typeof entry !== 'object') return []
        const record = entry as Record<string, unknown>
        const range = record.priceRange && typeof record.priceRange === 'object'
          ? record.priceRange as Record<string, unknown>
          : null
        const min = range?.min && typeof range.min === 'object' ? range.min as Record<string, unknown> : null
        const max = range?.max && typeof range.max === 'object' ? range.max as Record<string, unknown> : null
        if (typeof record.handle !== 'string' || typeof record.title !== 'string'
          || typeof record.availableForSale !== 'boolean' || typeof min?.amount !== 'string'
          || typeof min.currencyCode !== 'string' || typeof max?.amount !== 'string') return []
        const safeUrl = safeArticleUrl(record.url)
        const rawImage = record.image && typeof record.image === 'object' ? record.image as Record<string, unknown> : null
        const imageUrl = safeArticleUrl(rawImage?.url)
        const low = Number(min.amount)
        const high = Number(max.amount)
        const currencyCode = min.currencyCode
        const formatMoney = (amount: number): string => new Intl.NumberFormat('en-IN', {
          style: 'currency',
          currency: currencyCode,
          minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
          maximumFractionDigits: 2,
        }).format(amount)
        const price = Number.isFinite(low) && Number.isFinite(high)
          ? low === high ? formatMoney(low) : `${formatMoney(low)}–${formatMoney(high)}`
          : `${currencyCode} ${min.amount}`
        return [{
          handle: record.handle,
          title: record.title,
          availableForSale: record.availableForSale,
          price,
          url: safeUrl,
          image: imageUrl ? {
            url: imageUrl,
            altText: typeof rawImage?.altText === 'string' ? rawImage.altText : '',
          } : null,
        }]
      })
      .slice(0, 5)
    if (items.length > 0) {
      const anchor = afterReplyAnchor()
      pendingProductRevealAnchor = anchor
      const existing = products.find((entry) => entry.anchor === anchor)
      if (existing) existing.items = items
      else products.push({ anchor, items })
      renderThread()
    }
    return
  }
  if (message.type === 'voice_feedback_received') {
    const assistantTurn = Number(message.assistantTurn)
    const rating = message.rating
    if (Number.isInteger(assistantTurn) && (rating === 'helpful' || rating === 'not_helpful')) {
      feedbackPending.delete(assistantTurn)
      feedbackByTurn.set(assistantTurn, rating)
      announceStatus(rating === 'helpful' ? 'Marked as helpful. Thank you.' : 'Marked as not helpful. Thank you.')
      renderThread()
    }
    return
  }
  if (message.type === 'demo_session_cleared') {
    ticketAnchor = null
    sources = []
    products = []
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
    setConnectionStage('verifying', 'Secure connection found — finishing setup…')
    scheduleConnectionDelay()
    beginSessionProof()
  } else {
    callActive = false
    sessionReady = false
    if (hasConnected) {
      elements.reconnectBanner.hidden = false
      setConnectionStage('reconnecting', 'Connection interrupted. Your question will send when Ava is back.')
    } else {
      setConnectionStage('connecting', 'Ava is getting ready — you can ask now.')
    }
    scheduleConnectionDelay()
  }
  updateControls(client.status)
})
client.addEventListener('statuschange', updateControls)
client.addEventListener('metricschange', (metrics) => {
  if (!metrics) return
  client.sendJSON({
    type: 'voice_pipeline_metrics',
    llmMs: metrics.llm_ms,
    ttsMs: metrics.tts_ms,
    firstAudioMs: metrics.first_audio_ms,
    totalMs: metrics.total_ms,
  })
})
client.addEventListener('transcriptchange', (messages) => {
  const mergedMessages = mergeConversationHistory(restoredMessages, messages)
  const receivedReply = mergedMessages.some((message, index) => (
    message.role === 'assistant'
    && latestMessages[index]?.text !== message.text
  ))
  const receivedCustomerTurn = mergedMessages.some((message, index) => (
    message.role === 'user'
    && latestMessages[index]?.text !== message.text
  ))
  latestMessages = mergedMessages
  if (receivedCustomerTurn) replyFailed = false
  if (queuedMessageSent && queuedMessage !== null && mergedMessages.some((message) => (
    message.role === 'user' && message.text === queuedMessage
  ))) {
    queuedMessage = null
    queuedMessageSent = false
  }
  if (receivedReply) clearReplyWait()
  if (mergedMessages.length > 0) setConversationMode(true)
  updateControls(client.status)
  renderThread()
  if (receivedReply && client.status === 'idle') {
    const latestReply = [...mergedMessages].reverse().find((message) => message.role === 'assistant')?.text.trim()
    if (latestReply) announceStatus(`Ava: ${latestReply}`)
  }
})
client.addEventListener('interimtranscript', (text) => {
  interimText = text ?? ''
  renderThread()
})
client.addEventListener('mutechange', (muted) => {
  elements.muteButton.textContent = assistantMicPaused ? 'Mic paused' : muted ? 'Unmute' : 'Mute'
})
client.addEventListener('custommessage', renderCustomMessage)
client.addEventListener('error', (error) => {
  if (!error) return
  clearReplyWait()
  replyFailed = true
  if (queuedMessageSent) {
    queuedMessage = null
    queuedMessageSent = false
  }
  const copy = 'Ava couldn’t finish that answer. Please try again, or contact support if it keeps happening.'
  if (elements.app.dataset.view === 'landing') setConnectionStage('error', copy)
  else pushNote(copy)
  updateControls(client.status)
  renderThread()
})

async function toggleVoice(): Promise<void> {
  if (!callActive) {
    setConversationMode(true)
    try {
      await client.startCall()
      callActive = true
      pushNote('Voice on — Ava pauses the mic while speaking')
    } catch {
      callActive = false
      pushNote('Microphone access did not start. Check your browser permission, then tap the microphone to try again.')
      announceStatus('Microphone access did not start. Check your browser permission and try again.')
    }
  } else {
    playbackGuard.reset()
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
  if (callActive) {
    playbackGuard.reset()
    client.endCall()
  }
  callActive = false
  clearReplyWait()
  queuedMessage = null
  queuedMessageSent = false
  elements.clearButton.disabled = true
  client.sendJSON({ type: 'clear_demo_session' })
  resetReload = setTimeout(reloadFreshSession, 2_000)
  latestMessages = []
  restoredMessages = []
  notes = []
  sources = []
  products = []
  feedbackByTurn.clear()
  feedbackPending.clear()
  pendingProductRevealAnchor = null
  pendingFeedbackFocus = null
  ticketAnchor = null
  elements.handoffCard.hidden = true
  hideSignInCard()
  interimText = ''
  typing = false
  resetComposerInput(elements.landingInput)
  resetComposerInput(elements.textInput)
  signinReason = null
  setConversationMode(false, true)
  renderThread()
  updateControls(client.status)
})

function sendMessage(message: string): boolean {
  if (!message || queuedMessage !== null) return false
  setConversationMode(true)
  if (isReady()) {
    beginReplyWait()
    client.sendText(message)
  } else {
    queuedMessage = message
    queuedMessageSent = false
    setConnectionStage(
      connected ? 'verifying' : hasConnected ? 'reconnecting' : 'connecting',
      'Your question is saved and will send as soon as Ava is ready.',
    )
  }
  updateControls(client.status)
  renderThread()
  return true
}

function focusSupportRequest(): void {
  elements.landingInput.placeholder = 'Briefly describe what you need help with'
  elements.landingStatusCopy.textContent = 'Describe the issue first. Ava will ask you to sign in only if a private request is needed.'
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
  elements.landingInput.blur()
  if (sendMessage(message)) resetComposerInput(elements.landingInput)
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
  if (sendMessage(message)) resetComposerInput(elements.textInput)
})

for (const input of [elements.landingInput, elements.textInput]) {
  input.addEventListener('input', () => {
    resizeComposerInput(input)
    updateControls(client.status)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    input.form?.requestSubmit()
  })
  resizeComposerInput(input)
}

window.addEventListener('beforeunload', () => {
  viewportListenerAbort.abort()
  if (callActive) client.endCall()
  client.disconnect()
})

updateControls(client.status)
setConversationMode(false)
setConnectionStage('connecting', 'Ava is getting ready — you can ask now.')
scheduleConnectionDelay()
client.connect()
