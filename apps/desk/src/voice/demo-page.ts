import { workspaceShortName } from '../settings'

export const VOICE_DEMO_AGENT_NAME = 'AbleDeskAgent'
export const VOICE_DEMO_AGENT_PATH = '/agents/able-desk-agent/'

export type VoiceBranding = {
  displayName: string
  logoUrl: string | null
  faviconUrl: string | null
  homeUrl: string | null
}

export type VoiceHelpTopic = {
  slug: string
  name: string
  description: string
  articles: Array<{ slug: string; title: string }>
}

export function voiceDemoEnabled(env: { ABLE_VOICE_DEMO_ENABLED?: string }): boolean {
  return env.ABLE_VOICE_DEMO_ENABLED === '1'
}

export function isVoiceDemoAgentPath(pathname: string): boolean {
  return pathname.startsWith(VOICE_DEMO_AGENT_PATH)
}

function safeHttpsOrPath(value: string | null): string | null {
  if (!value) return null
  if (value.startsWith('/') && !value.startsWith('//')) return value
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

export function voiceBranding(settings: {
  displayName: string
  logoUrl: string | null
  faviconUrl: string | null
  homeUrl: string | null
}): VoiceBranding {
  return {
    displayName: settings.displayName,
    logoUrl: safeHttpsOrPath(settings.logoUrl),
    faviconUrl: safeHttpsOrPath(settings.faviconUrl),
    homeUrl: safeHttpsOrPath(settings.homeUrl),
  }
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;')
}

function monogram(displayName: string): string {
  const glyph = (word: string): string => word.match(/[\p{L}\p{N}]/u)?.[0] ?? ''
  const words = displayName.split(/\s+/).filter((word) => glyph(word) !== '')
  const letters = words.length >= 2
    ? `${glyph(words[0]!)}${glyph(words[1]!)}`
    : [...(words[0] ?? '').matchAll(/[\p{L}\p{N}]/gu)].slice(0, 2).map((match) => match[0]).join('')
  return (letters || 'S').toUpperCase()
}

export type VoiceIdentityView = {
  /** True when Shopify customer sign-in is configured for this deployment. */
  configured: boolean
  /** The signed-in customer's display name, or null when anonymous. */
  customerName: string | null
}

export function voiceDemoPageResponse(
  branding: VoiceBranding,
  turnstileSiteKey = '',
  ordersEnabled = false,
  topics: VoiceHelpTopic[] = [],
  identity: VoiceIdentityView = { configured: false, customerName: null },
  locale = 'en',
  voiceInputAvailable = true,
): Response {
  const indiaExperience = locale.toLowerCase() === 'en-in'
  const pageLanguage = indiaExperience ? 'en-IN' : 'en'
  const askPlaceholder = indiaExperience ? 'Ask in English or Hinglish' : 'Ask anything'
  const languageInvitation = indiaExperience
    ? ' English ya Hinglish—jismein aap comfortable hain.'
    : ''
  const workspaceName = workspaceShortName(branding.displayName)
  const title = /\bsupport$/i.test(branding.displayName.trim())
    ? `${branding.displayName} — assistant`
    : `${branding.displayName} support assistant`
  const brandVisual = branding.logoUrl
    ? `<img class="brand-logo" src="${escapeAttribute(branding.logoUrl)}" alt="">`
    : `<span class="brand-mark" aria-hidden="true">${escapeText(monogram(branding.displayName))}</span>`
  const favicon = branding.faviconUrl
    ? `\n    <link rel="icon" href="${escapeAttribute(branding.faviconUrl)}">`
    : ''
  const avatar = '<span class="avatar avatar--ava" aria-hidden="true"><i data-lucide="sparkles"></i></span>'
  const orderTaskCopy = identity.customerName
    ? 'You’re signed in — Ava can pull up your recent orders.'
    : ordersEnabled && identity.configured
      ? 'Sign in with your store account and Ava pulls it up instantly.'
      : ordersEnabled
        ? 'Share the order number and Ava will check it.'
        : 'Ask Ava for the available tracking steps.'
  const orderTaskMarkup = `<button class="support-task" type="button" data-support-message="I want to track my order." disabled>
                  <span class="support-task-icon" aria-hidden="true"><i data-lucide="truck"></i></span>
                  <span><span class="support-task-title">Track an order</span>
                  <span class="support-task-copy">${orderTaskCopy}</span></span>
                </button>`
  const accountMarkup = identity.customerName
    ? `<details class="account-menu">
                <summary aria-label="Account options for ${escapeAttribute(identity.customerName)}">
                  <span class="account-avatar" aria-hidden="true">${escapeText(monogram(identity.customerName).slice(0, 1))}</span>
                  <span class="account-name">${escapeText(identity.customerName)}</span>
                  <span class="account-chevron" aria-hidden="true"><i data-lucide="chevron-down"></i></span>
                </summary>
                <div class="account-popover">
                  <p><strong>${escapeText(identity.customerName)}</strong><span>Store account</span></p>
                  <a href="/auth/shopify/logout">Sign out</a>
                </div>
              </details>`
    : identity.configured
      ? `<a class="account-signin" href="/auth/shopify/start" aria-label="Sign in for order help">
          <span class="account-avatar account-avatar--anonymous" aria-hidden="true"><i data-lucide="user-round"></i></span>
          <span class="account-signin-label">Sign in</span>
        </a>`
      : `<a class="account-signin" href="/requests/recover" aria-label="Find your support request">
          <span class="account-avatar account-avatar--anonymous" aria-hidden="true"><i data-lucide="user-round"></i></span>
          <span class="account-signin-label">My request</span>
        </a>`
  const topicMarkup = topics.length > 0
    ? topics.slice(0, 9).map((topic) => `<section class="topic-card">
              <h3><a href="/kb?section=${encodeURIComponent(topic.slug)}">${escapeText(topic.name)}</a></h3>
              ${topic.description ? `<p>${escapeText(topic.description)}</p>` : ''}
              <ul>
                ${topic.articles.slice(0, 3).map((article) => `<li><a href="/kb/${encodeURIComponent(article.slug)}">${escapeText(article.title)}</a></li>`).join('\n                ')}
              </ul>
            </section>`).join('\n            ')
    : `<p class="topics-empty">Help articles are being prepared. Ava can still help you now.</p>`
  return new Response(`<!doctype html>
<html lang="${pageLanguage}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="light">
    <meta name="theme-color" content="#ffffff">
    <title>${escapeText(title)}</title>${favicon}
    <link rel="stylesheet" href="/workspace-theme.css">
    <link rel="stylesheet" href="/voice-demo.css">
    ${turnstileSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
    <script src="/voice-demo.js" defer></script>
  </head>
  <body>
    <a class="skip-link" href="#thread">Skip to support</a>
    <div id="support-app" class="app" data-view="landing" data-connection="connecting" data-voice-input="${voiceInputAvailable ? 'available' : 'unavailable'}">
      <header class="chat-header">
        <div class="chat-header-inner">
          <a class="brand" href="${escapeAttribute(branding.homeUrl ?? '/')}" aria-label="${escapeAttribute(`${branding.displayName} home`)}">
            ${brandVisual}
            <span class="brand-text">
              <span class="brand-name">${escapeText(workspaceName)}</span>
              <span class="brand-sub">Help</span>
            </span>
          </a>
          <div class="header-actions">
            <nav class="support-nav" aria-label="Support options">
              <a class="help-centre-link" href="/kb" aria-label="Help centre">
                <i data-lucide="book-open-text" aria-hidden="true"></i>
                <span class="nav-label">Help centre</span>
              </a>
              ${accountMarkup}
            </nav>
          </div>
        </div>
      </header>
      <div id="reconnect-banner" class="reconnect-banner" role="status" hidden>Reconnecting… Your message will send when Ava is back.</div>
      <div id="session-turnstile" class="session-turnstile" data-sitekey="${escapeAttribute(turnstileSiteKey)}"></div>

      <main id="thread" class="thread" tabindex="-1">
        <div class="thread-inner">
          <div id="landing-panel" class="landing-panel">
            <div class="landing-hero-layout">
              <section class="landing-hero" aria-labelledby="help-title">
                <p class="welcome-kicker"><i data-lucide="sparkles" aria-hidden="true"></i><span>Sales, support, and answers in one place</span></p>
                <h1 id="help-title">How can we help?</h1>
                <p class="landing-lede">Ask Ava about ${escapeText(workspaceName)} products, orders, or how-tos. She answers from our store and help centre, and brings in the team when you need them.${languageInvitation}</p>
                <form id="landing-form" class="ask-composer">
                  <span class="ask-icon" aria-hidden="true"><i data-lucide="sparkles"></i></span>
                  <textarea id="landing-input" name="question" rows="1" autocomplete="off" maxlength="500" placeholder="${askPlaceholder}" aria-label="${askPlaceholder}"></textarea>
                  <button id="landing-mic-button" class="mic-button ask-mic-button" type="button" aria-label="${voiceInputAvailable ? 'Use voice' : 'Voice requires a deployed preview'}" title="${voiceInputAvailable ? 'Talk instead of typing' : 'Streaming voice is available on deployed Workers'}" disabled>
                    <i data-lucide="mic" aria-hidden="true"></i>
                  </button>
                  <button id="landing-submit" type="submit" class="send-button ask-send-button" aria-label="Send question" disabled>
                    <i data-lucide="arrow-up" aria-hidden="true"></i>
                  </button>
                </form>
                <p class="landing-trust">${identity.customerName
                  ? `Signed in as ${escapeText(identity.customerName)}. Ava can use your store account for order help.`
                  : identity.configured
                    ? 'Start anonymously. Sign in only when you want order or private request help.'
                    : 'Start anonymously. Ava answers from the help centre; use the support form for follow-up.'}</p>
                <p id="landing-status" class="landing-status" role="status" aria-live="polite">
                  <span class="connection-dot" aria-hidden="true"></span>
                  <span id="landing-status-copy">Ava is getting ready — you can ask now.</span>
                </p>
              </section>

              <aside class="welcome-visual" aria-label="Ava can help with products, orders, and support">
                <div class="welcome-orb" aria-hidden="true">
                  <span class="welcome-orb-ring welcome-orb-ring--one"></span>
                  <span class="welcome-orb-ring welcome-orb-ring--two"></span>
                  <span class="welcome-avatar">${avatar}</span>
                </div>
                <div class="welcome-copy">
                  <p class="welcome-eyebrow"><span class="welcome-brand">${brandVisual}</span>Explore ${escapeText(workspaceName)}</p>
                  <h2>Find the right product. Get help after.</h2>
                </div>
                <div class="welcome-capabilities" aria-hidden="true">
                  <span><i data-lucide="package-search"></i>Product advice</span>
                  <span><i data-lucide="truck"></i>Order help</span>
                  <span><i data-lucide="book-open-text"></i>Clear how-tos</span>
                </div>
              </aside>
            </div>

            <section class="support-tasks" aria-labelledby="support-tasks-title">
              <div class="support-tasks-heading">
                <p class="eyebrow">Common tasks</p>
                <h2 id="support-tasks-title">Choose a starting point</h2>
              </div>
              <div class="support-task-grid">
                <button class="support-task support-task--featured" type="button" data-support-message="Help me choose the right product for my needs." disabled>
                  <span class="support-task-icon" aria-hidden="true"><i data-lucide="package-search"></i></span>
                  <span><span class="support-task-title">Find the right product</span>
                  <span class="support-task-copy">Share your needs and budget. Ava will narrow down the options.</span></span>
                </button>
                ${orderTaskMarkup}
                <button class="support-task" type="button" data-support-message="I need help with warranty or a repair." disabled>
                  <span class="support-task-icon" aria-hidden="true"><i data-lucide="wrench"></i></span>
                  <span><span class="support-task-title">Warranty or repair</span>
                  <span class="support-task-copy">Tell Ava what happened and she’ll guide you to the next step.</span></span>
                </button>
              </div>
              <div class="support-secondary-actions">
                <button id="human-help-button" type="button" disabled><i data-lucide="headphones" aria-hidden="true"></i><span><strong>Contact support</strong><small>Start with your issue; sign in only if a private request is needed.</small></span><i data-lucide="chevron-right" aria-hidden="true"></i></button>
                <a href="/requests/recover"><i data-lucide="file-search" aria-hidden="true"></i><span><strong>Find a request</strong><small>Recover a private case link securely.</small></span><i data-lucide="chevron-right" aria-hidden="true"></i></a>
              </div>
            </section>

            <section class="topics-section" aria-labelledby="topics-title">
              <div class="topics-heading">
                <h2 id="topics-title">Browse by topic</h2>
                <a href="/kb">Browse all</a>
              </div>
              <div class="topic-grid">
                ${topicMarkup}
              </div>
            </section>

          </div>

          <section class="conversation-toolbar" aria-label="Conversation controls">
            <div class="conversation-agent">
              ${avatar}
              <span><strong>Ava</strong><small>Sales &amp; support assistant</small></span>
            </div>
            <div class="conversation-actions">
              <div class="conversation-account">${accountMarkup}</div>
              <button id="conversation-human-button" class="conversation-help-button" type="button" aria-label="Contact support">
                <i data-lucide="headphones" aria-hidden="true"></i>
                <span>Contact support</span>
              </button>
              <button id="clear-button" class="new-conversation-button" type="button" aria-label="New conversation" hidden disabled>
                <i data-lucide="plus" aria-hidden="true"></i>
                <span>New conversation</span>
              </button>
            </div>
          </section>

          <ol id="transcript" class="thread-list" aria-label="Conversation with Ava" hidden>
            <li class="bubble-row bubble-row--assistant" id="signin-flow" hidden>
              ${avatar}
              <div class="bubble-stack">
                <div class="chat-card signin-card">
                  <p id="signin-card-lead" class="chat-card-lead">Sign in to continue</p>
                  <p id="signin-card-copy" class="chat-card-copy">Use your store account — a quick code by email, no password. You’ll come right back to this conversation.</p>
                  <button id="signin-button" class="access-button signin-button" type="button">Sign in with your store account</button>
                  <span class="access-feedback">Sign-in happens on the store’s own secure page.</span>
                </div>
              </div>
            </li>
            <li id="handoff-card" class="bubble-row bubble-row--assistant" hidden>
              ${avatar}
              <div class="chat-card ticket-card">
                <p class="eyebrow">Support ticket opened</p>
                <p class="ticket-title" id="handoff-category">Support ticket opened</p>
                <p class="ticket-copy" id="handoff-description">A support ticket was opened under your store account. The team will follow up by email.</p>
                <dl>
                  <div><dt>Reference</dt><dd id="handoff-reference">—</dd></div>
                  <div><dt>Status</dt><dd id="handoff-status">Open</dd></div>
                </dl>
              </div>
            </li>
          </ol>
        </div>
      </main>

      <footer id="composer-bar" class="composer-bar" hidden>
        <div class="composer-inner">
          <div id="voice-state" class="voice-state" hidden>
            <span class="voice-state-dot" aria-hidden="true"></span>
            <span id="voice-state-copy">Voice is on</span>
          </div>
          <form id="text-form" class="composer">
            <span class="composer-sparkle" aria-hidden="true"><i data-lucide="sparkles"></i></span>
            <textarea id="text-input" name="message" rows="1" autocomplete="off" maxlength="500" placeholder="Ask a follow-up…" aria-label="Ask a follow-up"></textarea>
            <button id="mic-button" class="mic-button" type="button" aria-label="Use voice" title="Talk instead of typing" disabled>
              <i data-lucide="mic" aria-hidden="true"></i>
            </button>
            <button id="mute-button" class="mute-button" type="button" hidden disabled>Mute</button>
            <button type="submit" class="send-button" aria-label="Send" disabled>
              <i data-lucide="arrow-up" aria-hidden="true"></i>
            </button>
          </form>
        </div>
      </footer>
      <p id="conversation-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p>
    </div>
  </body>
</html>`, {
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; base-uri 'none'; connect-src 'self' wss: https://challenges.cloudflare.com; font-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src https://challenges.cloudflare.com; img-src 'self' data: https:; media-src 'self' blob:; script-src 'self' blob: https://challenges.cloudflare.com; style-src 'self'; worker-src blob:",
      'content-type': 'text/html; charset=utf-8',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'camera=(), geolocation=(), microphone=(self), payment=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  })
}
