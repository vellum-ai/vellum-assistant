import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { executeBrowserType, isEnvVarValue } from '../browser-execution.js';
import type { Page } from '../browser-manager.js';
import { browserManager, setLaunchFn } from '../browser-manager.js';

// ── Helpers ──────────────────────────────────────────────────────────

function buildMockPage(overrides: Partial<Page> = {}): Page {
  return {
    close: async () => {},
    isClosed: () => false,
    goto: async () => null,
    title: async () => '',
    url: () => 'https://example.com',
    evaluate: async () => null,
    click: async () => {},
    fill: async () => {},
    press: async () => {},
    selectOption: async () => [] as string[],
    hover: async () => {},
    waitForSelector: async () => null,
    waitForFunction: async () => null,
    route: async () => {},
    unroute: async () => {},
    screenshot: async () => Buffer.from(''),
    keyboard: { press: async () => {} },
    mouse: { click: async () => {}, move: async () => {}, wheel: async () => {} },
    bringToFront: async () => {},
    on: () => {},
    ...overrides,
  };
}

// ── isEnvVarValue ────────────────────────────────────────────────────

describe('isEnvVarValue', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.TEST_SECRET_VALUE = 'my-secret-api-key-12345';
    process.env.TEST_EMPTY_VAR = '';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns true when text matches an env var value', () => {
    /**
     * Tests that isEnvVarValue correctly identifies text matching an env var.
     */

    // GIVEN an env var with a known value
    // (set in beforeEach: TEST_SECRET_VALUE = 'my-secret-api-key-12345')

    // WHEN we check text that exactly matches that value
    const result = isEnvVarValue('my-secret-api-key-12345');

    // THEN it should return true
    expect(result).toBe(true);
  });

  it('returns false when text does not match any env var value', () => {
    /**
     * Tests that isEnvVarValue returns false for non-matching text.
     */

    // GIVEN no env var has the value 'some-random-text-that-is-not-in-env'

    // WHEN we check text that doesn't match any env var
    const result = isEnvVarValue('some-random-text-that-is-not-in-env');

    // THEN it should return false
    expect(result).toBe(false);
  });

  it('returns false for empty strings', () => {
    /**
     * Tests that empty strings are not considered env var values.
     */

    // GIVEN an env var with an empty value exists

    // WHEN we check an empty string
    const result = isEnvVarValue('');

    // THEN it should return false (empty strings are not considered sensitive)
    expect(result).toBe(false);
  });

  it('returns false for partial matches', () => {
    /**
     * Tests that partial matches of env var values are not flagged.
     */

    // GIVEN an env var with value 'my-secret-api-key-12345'

    // WHEN we check text that is a substring of the env var value
    const result = isEnvVarValue('my-secret');

    // THEN it should return false (only exact matches count)
    expect(result).toBe(false);
  });
});

// ── executeBrowserType env var guard ─────────────────────────────────

describe('executeBrowserType — env var guard', () => {
  const ORIGINAL_ENV = { ...process.env };
  const SESSION_ID = 'test-session-env-guard';

  beforeEach(() => {
    process.env.TEST_BROWSER_SECRET = 'super-secret-value-xyz';
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    browserManager.clearSnapshotMap(SESSION_ID);
    await browserManager.closeAllPages();
    setLaunchFn(null);
  });

  it('rejects typing an env var value into a non-password input', async () => {
    /**
     * Tests that typing an env var value into a regular text input fails.
     */

    // GIVEN a mock page where the target element is NOT a password input
    const mockPage = buildMockPage({
      evaluate: async () => false,
    });

    setLaunchFn(async () => ({
      newPage: async () => mockPage,
      close: async () => {},
    }));

    // AND a snapshot map with an element
    const selectorMap = new Map<string, string>();
    selectorMap.set('e1', '[data-vellum-eid="e1"]');
    browserManager.storeSnapshotMap(SESSION_ID, selectorMap);

    // WHEN we try to type an env var value into the text input
    const result = await executeBrowserType(
      { element_id: 'e1', text: 'super-secret-value-xyz' },
      { sessionId: SESSION_ID, workingDir: '/tmp', conversationId: 'test-convo', guardianTrustClass: 'guardian' },
    );

    // THEN the tool call should fail with an appropriate error
    expect(result.isError).toBe(true);
    expect(result.content).toContain('environment variable');
    expect(result.content).toContain('password or secret input');
  });

  it('allows typing an env var value into a password input', async () => {
    /**
     * Tests that typing an env var value into a password input succeeds.
     */

    // GIVEN a mock page where the target element IS a password input
    let filledValue = '';
    const mockPage = buildMockPage({
      evaluate: async () => true,
      fill: async (_sel: string, value: string) => { filledValue = value; },
    });

    setLaunchFn(async () => ({
      newPage: async () => mockPage,
      close: async () => {},
    }));

    // AND a snapshot map with an element
    const selectorMap = new Map<string, string>();
    selectorMap.set('e1', '[data-vellum-eid="e1"]');
    browserManager.storeSnapshotMap(SESSION_ID, selectorMap);

    // WHEN we type an env var value into the password input
    const result = await executeBrowserType(
      { element_id: 'e1', text: 'super-secret-value-xyz' },
      { sessionId: SESSION_ID, workingDir: '/tmp', conversationId: 'test-convo', guardianTrustClass: 'guardian' },
    );

    // THEN the tool call should succeed
    expect(result.isError).toBe(false);

    // AND the value should have been filled
    expect(filledValue).toBe('super-secret-value-xyz');
  });

  it('allows typing non-env-var text into any input', async () => {
    /**
     * Tests that non-env-var text can be typed into any input type.
     */

    // GIVEN a mock page with a regular text input
    let filledValue = '';
    const mockPage = buildMockPage({
      evaluate: async () => false,
      fill: async (_sel: string, value: string) => { filledValue = value; },
    });

    setLaunchFn(async () => ({
      newPage: async () => mockPage,
      close: async () => {},
    }));

    // AND a snapshot map with an element
    const selectorMap = new Map<string, string>();
    selectorMap.set('e1', '[data-vellum-eid="e1"]');
    browserManager.storeSnapshotMap(SESSION_ID, selectorMap);

    // WHEN we type regular (non-env-var) text into the input
    const result = await executeBrowserType(
      { element_id: 'e1', text: 'hello world' },
      { sessionId: SESSION_ID, workingDir: '/tmp', conversationId: 'test-convo', guardianTrustClass: 'guardian' },
    );

    // THEN the tool call should succeed
    expect(result.isError).toBe(false);

    // AND the value should have been filled
    expect(filledValue).toBe('hello world');
  });
});
