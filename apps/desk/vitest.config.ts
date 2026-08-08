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
          // The pool loads a developer's local .dev.vars from the Wrangler
          // config directory. Tests assume these values are absent, so pin
          // them to empty strings — every gate treats '' as unconfigured —
          // to keep the suite hermetic regardless of local dev setup.
          TURNSTILE_SECRET_KEY: '',
          TURNSTILE_SITE_KEY: '',
          CUSTOMER_CAPABILITY_SECRET: '',
          ABLE_DEV_EMAIL: 'owner@example.com',
          ABLE_OPERATOR_HOSTNAME: 'operators.example.test',
          SHOPIFY_SHOP_DOMAIN: 'shop.example.test',
          SHOPIFY_ADMIN_TOKEN: 'local-test-token',
          SHOPIFY_CUSTOMER_CLIENT_ID: 'customer-test-client',
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
