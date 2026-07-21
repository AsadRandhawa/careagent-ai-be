import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // These are test-only fake values — never real secrets. They exist so
    // that importing server.js during a test run doesn't trip the
    // fail-fast boot check (missing JWT_SECRET/DATABASE_URL) or throw
    // inside the OpenAI/Stripe SDK constructors, which validate that an
    // API key string is present (not that it's valid) at construction
    // time. Nothing in this test suite makes a real network call to
    // OpenAI, Stripe, or a real database — @prisma/client is mocked in
    // every test file that imports server.js.
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test_only_fake_secret_do_not_use_in_prod_1234567890',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test_db',
      OPENAI_API_KEY: 'sk-test-fake-key-not-real',
      STRIPE_SECRET_KEY: 'sk_test_fake_key_not_real',
      // Deliberately left unset here: META_APP_SECRET, PADDLE_WEBHOOK_SECRET,
      // STRIPE_WEBHOOK_SECRET — the webhook signature tests set/unset these
      // per-test via vi.stubEnv() to exercise both the "configured" and
      // "not configured" fail-closed paths explicitly.
    },
    testTimeout: 10000,
  },
});
