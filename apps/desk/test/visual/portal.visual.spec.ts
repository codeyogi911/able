import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'

const visualCapability = 'visual-case-session-2026'

test.beforeEach(async ({ page }) => {
  // Keep the media feature explicit at page level as well as in the context.
  // This makes the acceptance assertion independent of project-use merging.
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
})

function viewportWidth(testInfo: { project: { use: { viewport?: { width: number; height: number } | null } } }): number {
  return testInfo.project.use.viewport?.width ?? 1440
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
}

async function expectMobileControls(page: Page, width: number, selector = 'button, .button, input:not([type="hidden"]), select, textarea'): Promise<void> {
  if (width > 390) return
  const controls = page.locator(selector).filter({ visible: true })
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index)
    const metrics = await control.evaluate((element) => {
      const style = getComputedStyle(element)
      const box = element.getBoundingClientRect()
      return {
        fontSize: Number.parseFloat(style.fontSize),
        height: box.height,
        element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.className ? `.${String(element.className).replaceAll(' ', '.')}` : ''}`,
      }
    })
    expect(metrics.fontSize, metrics.element).toBeGreaterThanOrEqual(16)
    expect(Math.round(metrics.height), metrics.element).toBeGreaterThanOrEqual(44)
  }
}

async function expectMobileTargets(page: Page, width: number, selector: string): Promise<void> {
  if (width > 390) return
  const targets = page.locator(selector).filter({ visible: true })
  for (let index = 0; index < await targets.count(); index += 1) {
    const target = targets.nth(index)
    const metrics = await target.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.className ? `.${String(element.className).replaceAll(' ', '.')}` : ''}`,
    }))
    expect(Math.round(metrics.height), metrics.element).toBeGreaterThanOrEqual(44)
  }
}

async function expectMobileOperatorDock(page: Page, width: number): Promise<void> {
  if (width > 800) return
  const metrics = await page.locator('.ops-nav').evaluate((element) => {
    const dock = element.getBoundingClientRect()
    const main = document.querySelector<HTMLElement>('.ops-main')
    return {
      position: getComputedStyle(element).position,
      bottom: dock.bottom,
      height: dock.height,
      viewportHeight: window.innerHeight,
      mainPaddingBottom: main ? Number.parseFloat(getComputedStyle(main).paddingBottom) : 0,
    }
  })
  expect(metrics.position).toBe('fixed')
  expect(Math.abs(metrics.bottom - metrics.viewportHeight)).toBeLessThanOrEqual(1)
  expect(metrics.mainPaddingBottom).toBeGreaterThanOrEqual(metrics.height)
}

async function expectReducedMotion(page: Page): Promise<void> {
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  const duration = await page.locator('.reveal, .article-list li, .thread-entry, body').first().evaluate((element) => {
    const value = getComputedStyle(element).animationDuration.split(',')[0]?.trim() ?? '0s'
    return value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1_000
  })
  expect(duration).toBeLessThanOrEqual(1)
}

function channel(value: number): number {
  const normalized = value / 255
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function rgb(value: string): [number, number, number] {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (match) return [Number(match[1]), Number(match[2]), Number(match[3])]
  const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255]
  throw new Error(`Unsupported browser color: ${value}`)
}

function contrast(foreground: string, background: string): number {
  const luminance = ([red, green, blue]: [number, number, number]) => 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  const first = luminance(rgb(foreground))
  const second = luminance(rgb(background))
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

async function expectCoreContrast(page: Page): Promise<void> {
  const colors = await page.locator('body').evaluate((body) => {
    const bodyStyle = getComputedStyle(body)
    const action = document.querySelector<HTMLElement>('button:not(.button-secondary):not(.text-button):not(.mic-button):not(:disabled), a.button:not(.button-secondary)')
    const actionStyle = action ? getComputedStyle(action) : null
    const footer = document.querySelector<HTMLElement>('.site-footer')
    const footerInner = document.querySelector<HTMLElement>('.footer-inner')
    return {
      bodyForeground: bodyStyle.color,
      bodyBackground: bodyStyle.backgroundColor,
      actionForeground: actionStyle?.color ?? '',
      actionBackground: actionStyle?.backgroundColor ?? '',
      footerForeground: footerInner ? getComputedStyle(footerInner).color : '',
      footerBackground: footer ? getComputedStyle(footer).backgroundColor : '',
    }
  })
  expect(contrast(colors.bodyForeground, colors.bodyBackground)).toBeGreaterThanOrEqual(4.5)
  if (colors.footerForeground && colors.footerBackground) {
    expect(contrast(colors.footerForeground, colors.footerBackground)).toBeGreaterThanOrEqual(4.5)
  }
  if (colors.actionForeground && colors.actionBackground) {
    expect(contrast(colors.actionForeground, colors.actionBackground)).toBeGreaterThanOrEqual(4.5)
  }
}

async function expectAcceptanceBasics(page: Page, width: number): Promise<void> {
  await expectNoHorizontalOverflow(page)
  await expectMobileControls(page, width)
  await expectReducedMotion(page)
  await expectCoreContrast(page)
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  // Queue age is derived from wall-clock time by the Worker. Hide only that
  // value during capture so the baseline remains stable across calendar days.
  await page.locator('.queue-age > strong').evaluateAll((elements) => {
    for (const element of elements) element.setAttribute('hidden', '')
  })
  await expect(page).toHaveScreenshot(name, { fullPage: true })
}

type VoiceSocketFixture = {
  releaseSession(): void
}

async function installVoiceSocketFixture(
  page: Page,
  options: {
    holdSessionReady?: boolean
    contactContinuation?: 'order_lookup' | 'open_ticket' | 'product_help'
  } = {},
): Promise<VoiceSocketFixture> {
  let socket: WebSocketRoute | null = null
  let readyPending = false
  let readyReleased = options.holdSessionReady !== true
  let turn = 0

  const send = (message: Record<string, unknown>) => {
    socket?.send(JSON.stringify(message))
  }
  const sendReady = () => send({ type: 'voice_session_ready' })

  await page.routeWebSocket(/\/agents\/morrow-desk-agent\//, (route) => {
    socket = route
    route.onMessage((message) => {
      if (typeof message !== 'string') return
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(message) as Record<string, unknown>
      } catch {
        return
      }

      if (parsed.type === 'start_voice_session') {
        if (readyReleased) sendReady()
        else readyPending = true
        return
      }
      if (parsed.type === 'set_voice_contact') {
        send({
          type: 'voice_contact_set',
          contact: { name: parsed.name, email: parsed.email },
          continuation: options.contactContinuation ?? 'continue',
        })
        return
      }
      if (parsed.type !== 'text_message' || typeof parsed.text !== 'string') return

      turn += 1
      const answer = `Deterministic support answer ${turn}. Keep the machine unplugged while checking the removable parts. Use the published care instructions below, and stop if anything looks damaged.`
      send({ type: 'status', status: 'thinking' })
      send({ type: 'transcript', role: 'user', text: parsed.text })
      if (turn === 1 && options.contactContinuation) {
        send({ type: 'voice_contact_required', anchor: 'after_reply' })
      }
      send({
        type: 'voice_sources',
        articles: [{
          title: 'Care and troubleshooting guide',
          section: 'Diagnostics',
          url: '/kb/care-and-troubleshooting-guide',
        }],
      })
      send({ type: 'transcript_start' })
      send({ type: 'transcript_end', text: answer })
      send({ type: 'status', status: 'idle' })
    })
  })

  return {
    releaseSession() {
      readyReleased = true
      if (!readyPending) return
      readyPending = false
      sendReady()
    },
  }
}

async function openDeterministicConversation(page: Page): Promise<void> {
  await installVoiceSocketFixture(page)
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByLabel('Ask anything')).toBeEnabled()

  await page.getByLabel('Ask anything').fill('How should I care for my machine?')
  await page.getByRole('button', { name: 'Send question' }).click()
  await expect(page.getByText('Deterministic support answer 1.', { exact: false })).toBeVisible()

  for (const [index, question] of [
    'What should I inspect first?',
    'What if the problem continues?',
  ].entries()) {
    await page.getByLabel('Ask a follow-up').fill(question)
    await page.locator('#text-form').getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText(`Deterministic support answer ${index + 2}.`, { exact: false })).toBeVisible()
  }
}

async function openCustomerSession(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' })
  const status = await page.evaluate(async (capability) => {
    const response = await fetch('/requests/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-morrow-capability-exchange': '1' },
      body: JSON.stringify({ capability }),
    })
    return response.status
  }, visualCapability)
  expect(status).toBe(204)
  const response = await page.goto('/requests/case', { waitUntil: 'networkidle' })
  expect(response?.status()).toBe(200)
  expect(page.url()).not.toContain(visualCapability)
  expect(page.url()).not.toContain('#')
  expect(await page.content()).not.toContain(visualCapability)
}

test('support home opens with the agent as the primary help experience', async ({ page }, testInfo) => {
  await installVoiceSocketFixture(page)
  const response = await page.goto('/', { waitUntil: 'networkidle' })
  expect(response?.status()).toBe(200)
  await expect(page).toHaveTitle(/Morrow Desk support assistant/)
  await expect(page.getByRole('heading', { level: 1, name: 'How can we help?' })).toBeVisible()
  await expect(page.getByLabel('Ask anything')).toBeEnabled()
  await expect(page.getByRole('search')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Browse help' })).toHaveAttribute('href', '/kb')
  await expect(page.getByRole('heading', { level: 2, name: 'Browse by topic' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ask the team' })).toBeEnabled()

  const composerPosition = await page.locator('.ask-composer').evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, viewportHeight: window.innerHeight }
  })

  const width = viewportWidth(testInfo)
  if (width <= 700) {
    expect(composerPosition.top).toBeGreaterThan(composerPosition.viewportHeight * .65)
    expect(composerPosition.bottom).toBeLessThanOrEqual(composerPosition.viewportHeight - 12)
  } else {
    expect(composerPosition.top).toBeLessThan(composerPosition.viewportHeight * .55)
  }
  await expectAcceptanceBasics(page, width)
  await expectMobileTargets(page, width, '.support-nav a, .topics-heading a, .topic-card a')
  await screenshot(page, 'agent-home.png')
})

test('contact continuation stays out of the customer transcript', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'The mobile contact handoff is covered once.')
  await installVoiceSocketFixture(page, { contactContinuation: 'order_lookup' })
  await page.goto('/', { waitUntil: 'networkidle' })

  await page.getByLabel('Ask anything').fill('Where is my order?')
  await page.getByRole('button', { name: 'Send question' }).click()
  await expect(page.getByLabel('Name')).toBeVisible()
  await expect(page.getByText('Deterministic support answer 1.', { exact: false })).toBeVisible()

  await page.getByLabel('Name').fill('Avery Customer')
  await page.getByLabel('Email').fill('avery@example.test')
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByText('We’ll use avery@example.test for this support action')).toBeVisible()
  await expect(page.getByText('Deterministic support answer 2.', { exact: false })).toBeVisible()
  await expect(page.getByText('I have shared my name and email.', { exact: false })).toHaveCount(0)
})

test('mobile landing remains stable while the agent session becomes ready', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'The delayed readiness lifecycle is covered at one phone viewport.')
  const fixture = await installVoiceSocketFixture(page, { holdSessionReady: true })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const input = page.getByLabel('Ask anything')
  const submit = page.getByRole('button', { name: 'Send question' })
  const hero = page.locator('.landing-hero')
  const before = await hero.evaluate((element) => element.getBoundingClientRect().top)

  await expect(input).toBeEnabled()
  await expect(submit).toBeDisabled()
  await expect(input).toHaveAttribute('placeholder', 'Ask anything')
  await input.fill('Keep this question while the session connects')
  await expect(input).toHaveValue('Keep this question while the session connects')

  fixture.releaseSession()
  await expect(input).toBeEnabled()
  await expect(submit).toBeEnabled()
  await expect(input).toHaveAttribute('placeholder', 'Ask anything')
  await expect(input).toHaveValue('Keep this question while the session connects')
  const after = await hero.evaluate((element) => element.getBoundingClientRect().top)

  expect(Math.abs(after - before)).toBeLessThanOrEqual(1)
})

test('an interactive mobile Turnstile challenge does not move the landing hero', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'The Turnstile layout boundary is covered at one phone viewport.')
  await installVoiceSocketFixture(page, { holdSessionReady: true })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const hero = page.locator('.landing-hero')
  const before = await hero.evaluate((element) => element.getBoundingClientRect().top)
  await page.locator('#session-turnstile').evaluate((container) => {
    const challenge = document.createElement('div')
    challenge.className = 'cf-turnstile'
    challenge.setAttribute('aria-label', 'Anti-spam challenge')
    container.append(challenge)
  })
  const after = await hero.evaluate((element) => element.getBoundingClientRect().top)

  expect(Math.abs(after - before)).toBeLessThanOrEqual(1)
})

test('mobile conversation owns scrolling and keeps its composer in usable phone space', async ({ page }, testInfo) => {
  test.skip(!['mobile-360', 'mobile-390'].includes(testInfo.project.name), 'Phone-shell regression coverage.')
  const initialViewport = page.viewportSize()
  if (!initialViewport) throw new Error('Phone viewport is required')
  await page.addInitScript(({ height }) => {
    let viewportHeight = height
    let viewportOffsetTop = 0
    const visualViewport = new EventTarget()
    Object.defineProperties(visualViewport, {
      height: { get: () => viewportHeight },
      offsetTop: { get: () => viewportOffsetTop },
      width: { get: () => window.innerWidth },
      offsetLeft: { get: () => 0 },
      pageLeft: { get: () => 0 },
      pageTop: { get: () => viewportOffsetTop },
      scale: { get: () => 1 },
    })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport })
    Object.assign(window, {
      __setSupportVisualViewport(next: { height: number; offsetTop: number }) {
        viewportHeight = next.height
        viewportOffsetTop = next.offsetTop
        visualViewport.dispatchEvent(new Event('resize'))
        visualViewport.dispatchEvent(new Event('scroll'))
      },
    })
  }, { height: initialViewport.height })
  await openDeterministicConversation(page)

  const measureShell = () => page.evaluate(() => {
    const root = document.documentElement
    const body = document.body
    const thread = document.querySelector<HTMLElement>('#thread')
    const form = document.querySelector<HTMLElement>('#text-form')
    const composer = document.querySelector<HTMLElement>('#composer-bar')
    if (!thread || !form || !composer) throw new Error('Conversation shell is incomplete')
    const formBox = form.getBoundingClientRect()
    const composerBox = composer.getBoundingClientRect()
    const visualBottom = (window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? window.innerHeight)
    return {
      bodyOverflow: body.scrollHeight - window.innerHeight,
      rootOverflow: root.scrollHeight - root.clientHeight,
      formGap: visualBottom - formBox.bottom,
      threadOverflowY: getComputedStyle(thread).overflowY,
      threadScrollable: thread.scrollHeight > thread.clientHeight + 1,
      threadBottomDistance: thread.scrollHeight - thread.scrollTop - thread.clientHeight,
      threadBottom: thread.getBoundingClientRect().bottom,
      composerTop: composerBox.top,
      shellTop: document.querySelector<HTMLElement>('#support-app')?.getBoundingClientRect().top ?? -1,
      shellHeight: document.querySelector<HTMLElement>('#support-app')?.getBoundingClientRect().height ?? -1,
      visualTop: window.visualViewport?.offsetTop ?? 0,
      visualHeight: window.visualViewport?.height ?? window.innerHeight,
    }
  })

  const finalTurnDelta = () => page.locator('#thread').evaluate((thread) => {
    const visibleItems = [...thread.querySelectorAll<HTMLElement>('#transcript > li')]
      .filter((item) => getComputedStyle(item).display !== 'none')
    const last = visibleItems.at(-1)
    if (!last) throw new Error('Conversation has no visible final item')
    return last.getBoundingClientRect().bottom - thread.getBoundingClientRect().bottom
  })

  const initial = await measureShell()
  expect.soft(initial.bodyOverflow).toBeLessThanOrEqual(1)
  expect.soft(initial.rootOverflow).toBeLessThanOrEqual(1)
  expect.soft(initial.formGap).toBeGreaterThanOrEqual(15)
  expect.soft(initial.formGap).toBeLessThanOrEqual(20)
  expect.soft(initial.threadOverflowY).toBe('auto')
  expect.soft(initial.threadScrollable).toBe(true)
  expect.soft(initial.threadBottomDistance).toBeLessThan(120)
  expect.soft(initial.threadBottom).toBeLessThanOrEqual(initial.composerTop + 1)
  await expect.poll(finalTurnDelta).toBeLessThanOrEqual(1)

  await page.evaluate(({ height }) => {
    const testWindow = window as typeof window & {
      __setSupportVisualViewport(next: { height: number; offsetTop: number }): void
    }
    testWindow.__setSupportVisualViewport({ height, offsetTop: 12 })
  }, { height: initialViewport.height - 300 })
  await expect.poll(async () => {
    const metrics = await measureShell()
    return metrics.formGap >= 15 && metrics.formGap <= 20
  }).toBe(true)
  const reduced = await measureShell()
  expect.soft(reduced.bodyOverflow).toBeLessThanOrEqual(1)
  expect.soft(reduced.rootOverflow).toBeLessThanOrEqual(1)
  expect.soft(reduced.formGap).toBeGreaterThanOrEqual(15)
  expect.soft(reduced.formGap).toBeLessThanOrEqual(20)
  expect.soft(reduced.threadScrollable).toBe(true)
  expect.soft(reduced.shellTop).toBe(12)
  expect.soft(reduced.shellHeight).toBe(initialViewport.height - 300)
  expect.soft(reduced.visualTop).toBe(12)
  expect.soft(reduced.visualHeight).toBe(initialViewport.height - 300)
  await expect.poll(finalTurnDelta).toBeLessThanOrEqual(1)

  await page.evaluate(({ height }) => {
    const testWindow = window as typeof window & {
      __setSupportVisualViewport(next: { height: number; offsetTop: number }): void
    }
    testWindow.__setSupportVisualViewport({ height, offsetTop: 0 })
  }, { height: initialViewport.height })
  await expect.poll(async () => {
    const metrics = await measureShell()
    return metrics.formGap >= 15 && metrics.formGap <= 20
  }).toBe(true)
})

test('legacy voice route redirects to the agent home', async ({ page }) => {
  await installVoiceSocketFixture(page)
  const response = await page.goto('/voice', { waitUntil: 'networkidle' })
  expect(response?.status()).toBe(200)
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByLabel('Ask anything')).toBeEnabled()
})

test('first question transitions into the focused answer experience', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'The state transition is viewport-independent and covered once.')
  await installVoiceSocketFixture(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.getByLabel('Ask anything').fill('How should I clean my router?')
  await page.getByRole('button', { name: 'Send question' }).click()

  await expect(page.locator('#support-app')).toHaveAttribute('data-view', 'conversation')
  await expect(page.locator('#landing-panel')).toBeHidden()
  await expect(page.locator('#transcript')).toBeVisible()
  await expect(page.getByLabel('Ask a follow-up')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start over' })).toBeVisible()

  await page.getByRole('button', { name: 'Start over' }).click()
  await expect(page.locator('#support-app')).toHaveAttribute('data-view', 'landing')
  await expect(page.getByRole('heading', { level: 1, name: 'How can we help?' })).toBeVisible()
  await expect(page.getByLabel('Ask anything')).toBeEnabled()
  await expect(page.getByLabel('Ask anything')).toBeFocused()

  await page.getByLabel('Ask anything').fill('What does the warranty cover?')
  await page.getByRole('button', { name: 'Send question' }).click()
  await expect(page.getByText('What does the warranty cover?', { exact: true })).toBeVisible()
  await expect(page.getByText('How should I clean my router?', { exact: true })).toHaveCount(0)
})

test('knowledge search remains a normal secondary search', async ({ page }) => {
  await page.route(/\/kb\?q=/, async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Knowledge search</title><p>Knowledge search</p>',
    })
  })
  await page.goto('/kb', { waitUntil: 'networkidle' })
  await page.locator('#kb-query-compact').fill('cleaning')
  await expect(page.locator('.search-option--ask')).toHaveCount(0)
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page).toHaveURL(/\/kb\?q=cleaning$/)
})

test('active request form is ready and mobile safe', async ({ page }, testInfo) => {
  const response = await page.goto('/requests/new', { waitUntil: 'networkidle' })
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tell us what happened.')
  await expect(page.getByText('New requests are temporarily paused')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open my request' })).toBeEnabled()

  const width = viewportWidth(testInfo)
  await expectAcceptanceBasics(page, width)
  await expect(page.getByLabel('Your name')).toHaveAttribute('required', '')
  await page.getByLabel('Your name').focus()
  await expect(page.getByLabel('Your name')).toBeFocused()
  await screenshot(page, 'request-active.png')
})

test('published knowledge article keeps readable hierarchy', async ({ page }, testInfo) => {
  const response = await page.goto('/kb/collect-a-diagnostic-bundle', { waitUntil: 'networkidle' })
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Collect a useful diagnostic bundle')
  await expect(page.getByRole('heading', { name: 'Capture the useful detail' })).toBeVisible()
  await expect(page.getByText('A short, focused log is safer')).toBeVisible()

  const width = viewportWidth(testInfo)
  await expectAcceptanceBasics(page, width)
  await screenshot(page, 'knowledge-article.png')
})

test('customer case uses a fixed session route without exposing its capability', async ({ page }, testInfo) => {
  await openCustomerSession(page)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Desktop app stops during report export')
  await expect(page.getByText('Inez Calder', { exact: true })).toBeVisible()
  await expect(page.getByText('Reproduced only when')).toHaveCount(0)
  await expect(page.getByRole('link', { name: /export-window\.log/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send reply' })).toBeEnabled()

  const width = viewportWidth(testInfo)
  await expectAcceptanceBasics(page, width)
  await screenshot(page, 'customer-case.png')
})

test('lost-link recovery is non-enumerating and ready', async ({ page }, testInfo) => {
  const response = await page.goto('/requests/recover', { waitUntil: 'networkidle' })
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ask for a fresh private link.')
  await expect(page.getByText('We give the same answer whether or not the details match.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send a fresh link' })).toBeEnabled()

  const width = viewportWidth(testInfo)
  await expectAcceptanceBasics(page, width)
  await screenshot(page, 'request-recovery.png')
})

test('Access-gated recovery console collapses cleanly', async ({ page }, testInfo) => {
  const response = await page.goto('/ops', { waitUntil: 'networkidle' })
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Work queue')
  const seededCase = page.getByRole('link', { name: /Desktop app stops during report export/ })
  await expect(seededCase).toBeVisible()
  await expect(seededCase).toContainText('Romy Navarro')

  const width = viewportWidth(testInfo)
  await expectAcceptanceBasics(page, width)
  if (width <= 390) {
    await expectMobileTargets(page, width, '.ops-nav a, .queue-row, button, input:not([type="hidden"]), select, textarea')
  }
  await expectMobileOperatorDock(page, width)
  await screenshot(page, 'ops-queue.png')

  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to console' })).toBeFocused()
})
