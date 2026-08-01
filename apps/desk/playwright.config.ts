import { defineConfig } from '@playwright/test'

const viewports = [
  { name: 'mobile-360', width: 360, height: 800 },
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1440', width: 1440, height: 1000 },
]
const visualPort = Number.parseInt(process.env.MORROW_VISUAL_PORT ?? '8791', 10)
if (!Number.isInteger(visualPort) || visualPort < 1024 || visualPort > 65535) throw new Error('MORROW_VISUAL_PORT must be an unprivileged TCP port')
const baseURL = `http://127.0.0.1:${visualPort}`

export default defineConfig({
  testDir: './test/visual',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  snapshotPathTemplate: '{testDir}/snapshots/{platform}/{projectName}/{arg}{ext}',
  expect: { toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 } },
  use: {
    baseURL,
    browserName: 'chromium',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: viewports.map(({ name, width, height }) => ({
    name,
    use: { viewport: { width, height }, reducedMotion: 'reduce' as const },
  })),
  webServer: {
    command: 'npm run visual:server',
    url: `${baseURL}/healthz`,
    // A developer Wrangler process can be healthy on the same port while
    // lacking the seeded D1 and local Access identity this suite requires.
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
