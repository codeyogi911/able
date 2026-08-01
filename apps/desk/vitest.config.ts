import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // Workers AI is remote-only in local emulation. Keep the production AI
      // binding out of the hermetic test runtime and inject MediaAnalyzer fakes
      // at the platform seam instead.
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        bindings: {
          MORROW_DEV_EMAIL: 'owner@example.com',
          MORROW_OPERATOR_HOSTNAME: 'operators.example.test',
          VOICE_TEST_OTP_CODE: '123456',
          WHATSAPP_VERIFY_TOKEN: 'whatsapp-test-verify-token',
          WHATSAPP_APP_SECRET: 'whatsapp-test-app-secret',
          WHATSAPP_ACCESS_TOKEN: 'whatsapp-test-access-token',
          WHATSAPP_PHONE_NUMBER_ID: 'test-phone-number-id',
          WHATSAPP_WABA_ID: 'test-waba-id',
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
        },
      },
    })),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.node.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ['xss'],
        },
      },
    },
  },
})
