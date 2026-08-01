import { readFile } from 'node:fs/promises'

import { expect, test } from '@playwright/test'

const opsCss = await readFile(new URL('../../public/ops.css', import.meta.url), 'utf8')

function viewportWidth(testInfo: { project: { use: { viewport?: { width: number; height: number } | null } } }): number {
  return testInfo.project.use.viewport?.width ?? 1440
}

test('operator navigation docks above the mobile safe area without covering console content', async ({ page }, testInfo) => {
  await page.setContent(`
    <style>${opsCss}</style>
    <a class="skip-link" href="#ops-main">Skip to console</a>
    <div class="ops-shell">
      <aside class="ops-sidebar">
        <a class="brand-link" href="/ops"><span class="brand-lockup"><span class="brand-mark">MO</span><span class="brand-name">Morrow Desk</span></span></a>
        <nav class="ops-nav" aria-label="Operator console">
          <a aria-current="page" href="/ops">Queue</a><a href="/ops/conversations">Inbox</a><a href="/ops/outbox">Outbox</a><a href="/ops/status">Status</a><a href="/ops/settings">Settings</a>
        </nav>
      </aside>
      <main id="ops-main" class="ops-main"><div style="min-height: 1600px"><h1>Work queue</h1><button>Queue public reply</button></div></main>
    </div>
  `)

  const width = viewportWidth(testInfo)
  if (width > 800) return

  const initial = await page.locator('.ops-nav').evaluate((element) => {
    const dock = element.getBoundingClientRect()
    const main = document.querySelector<HTMLElement>('.ops-main')
    return {
      position: getComputedStyle(element).position,
      bottom: dock.bottom,
      height: dock.height,
      viewportHeight: window.innerHeight,
      mainPaddingBottom: main ? Number.parseFloat(getComputedStyle(main).paddingBottom) : 0,
      targetHeights: Array.from(element.querySelectorAll('a'), (link) => link.getBoundingClientRect().height),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })

  expect(initial.position).toBe('fixed')
  expect(Math.abs(initial.bottom - initial.viewportHeight)).toBeLessThanOrEqual(1)
  expect(initial.mainPaddingBottom).toBeGreaterThanOrEqual(initial.height)
  expect(initial.targetHeights.every((height) => height >= 44)).toBe(true)
  expect(initial.overflow).toBeLessThanOrEqual(1)

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  const dockBottomAfterScroll = await page.locator('.ops-nav').evaluate((element) => element.getBoundingClientRect().bottom)
  expect(Math.abs(dockBottomAfterScroll - await page.evaluate(() => window.innerHeight))).toBeLessThanOrEqual(1)
})

test('a case video cannot widen the mobile operator console', async ({ page }, testInfo) => {
  await page.setContent(`
    <style>${opsCss}</style>
    <div class="ops-shell">
      <aside class="ops-sidebar"><nav class="ops-nav" aria-label="Operator console"><a aria-current="page" href="/ops">Queue</a><a href="/ops/conversations">Inbox</a><a href="/ops/outbox">Outbox</a><a href="/ops/status">Status</a><a href="/ops/settings">Settings</a></nav></aside>
      <main class="ops-main">
        <div class="case-console-grid">
          <section class="ops-thread"><article class="ops-thread-entry"><ul class="ops-attachments"><li><video controls width="478">Your browser cannot play this video.</video><a href="/ops/video"><span>demo_video.mp4</span><small>9.4 MB</small></a></li></ul></article></section>
          <aside class="case-actions"><section class="action-block"><div class="section-bar"><h2>Emergency reply</h2><span>Public</span></div><form class="ops-form"><textarea aria-label="Customer reply"></textarea><button>Queue public reply</button></form></section></aside>
        </div>
      </main>
    </div>
  `)

  if (viewportWidth(testInfo) > 800) return

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})
