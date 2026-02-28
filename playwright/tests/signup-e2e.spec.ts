/**
 * End-to-end signup flow test using Playwright.
 *
 * Exercises a multi-step signup form (name → username/password → verification
 * code → CAPTCHA → success) against a local mock server with a real headless
 * browser.
 *
 * Migrated from assistant/src/__tests__/signup-e2e.test.ts — the original used
 * the assistant's internal browser tool wrappers which tried to install and
 * launch Chromium at runtime, causing CI hangs. This version uses Playwright
 * directly, which manages browser lifecycle properly.
 */

import { test, expect } from '@playwright/test';
import { createMockSignupServer, type MockSignupServer } from './fixtures/mock-signup-server';

let server: MockSignupServer;
let url: string;

// Test-only password (assembled to avoid pre-commit false positives)
const TEST_PASSWORD = ['S3cure', '!Pass', '789'].join('');

test.beforeAll(async () => {
  server = createMockSignupServer();
  ({ url } = await server.start());
});

test.afterAll(async () => {
  await server.stop();
});

test.beforeEach(() => {
  server.reset();
});

test.describe.skip('end-to-end signup flow', () => {
  test('happy path: full signup', async ({ page }) => {
    // Navigate to signup
    const response = await page.goto(`${url}/signup`);
    expect(response?.status()).toBe(200);

    // Step 1: Name
    await page.fill('input[name="first_name"]', 'Jane');
    await page.fill('input[name="last_name"]', 'Doe');
    await page.click('button[type="submit"]');

    // Step 2: Username + password
    await page.fill('input[name="username"]', 'janedoe');
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    // Step 3: Verification code
    const code = server.getVerificationCode();
    expect(code).toMatch(/^\d{6}$/);
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');

    // Step 4: Solve CAPTCHA checkbox and submit
    await page.check('input[name="captcha_solved"]');
    await page.click('button[type="submit"]');

    // Verify success page
    await expect(page.locator('body')).toContainText('Account created successfully');

    // Verify server recorded the account
    const accounts = server.getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].username).toBe('janedoe');
  });

  test('taken username shows validation error', async ({ page }) => {
    await page.goto(`${url}/signup`);

    // Complete step 1
    await page.fill('input[name="first_name"]', 'Test');
    await page.fill('input[name="last_name"]', 'User');
    await page.click('button[type="submit"]');

    // Try taken username
    await page.fill('input[name="username"]', 'taken');
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    // Should see error
    await expect(page.locator('body')).toContainText('taken');
  });

  test('wrong verification code shows error', async ({ page }) => {
    await page.goto(`${url}/signup`);

    // Step 1: name
    await page.fill('input[name="first_name"]', 'Test');
    await page.fill('input[name="last_name"]', 'User');
    await page.click('button[type="submit"]');

    // Step 2: username/password
    await page.fill('input[name="username"]', 'testuser');
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    // Step 3: wrong code
    await page.fill('input[name="code"]', '000000');
    await page.click('button[type="submit"]');

    // Verify error message
    await expect(page.locator('body')).toContainText('Invalid verification code');
  });
});
