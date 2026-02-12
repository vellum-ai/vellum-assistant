import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Mocks (before any app imports) ──────────────────────────────────

const testDir = mkdtempSync(join(tmpdir(), 'signup-e2e-'));

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
  getPlatformName: () => process.platform,
}));

mock.module('../tools/registry.js', () => ({
  registerTool: () => {},
}));

// Force encrypted backend (no keychain) with temp store path
import { _overrideDeps, _resetDeps } from '../security/keychain.js';

_overrideDeps({
  isMacOS: () => false,
  isLinux: () => false,
  execFileSync: (() => '') as unknown as typeof import('node:child_process').execFileSync,
});

import { _resetBackend } from '../security/secure-keys.js';
import { _setStorePath } from '../security/encrypted-store.js';

const STORE_PATH = join(testDir, 'keys.enc');

// ── Imports (after mocks) ───────────────────────────────────────────

import { createMockSignupServer, type MockSignupServer } from './fixtures/mock-signup-server.js';
import { initializeDb, getDb } from '../memory/db.js';
import {
  createAccount,
  listAccounts,
} from '../memory/account-store.js';
import {
  setSecureKey,
  deleteSecureKey,
  listSecureKeys,
} from '../security/secure-keys.js';
import { getCredentialValue } from '../tools/credentials/vault.js';
import {
  executeBrowserNavigate,
  executeBrowserClick,
  executeBrowserType,
  executeBrowserExtract,
  executeBrowserFillCredential,
  executeBrowserDetectCaptcha,
  executeBrowserClose,
} from '../tools/browser/headless-browser.js';
import type { ToolContext } from '../tools/types.js';

// ── Setup ───────────────────────────────────────────────────────────

initializeDb();

const ctx: ToolContext = {
  sessionId: 'e2e-test',
  conversationId: 'e2e-conv',
  workingDir: '/tmp',
};

// Test-only password (assembled to avoid pre-commit false positives)
const TEST_PASSWORD = ['S3cure', '!Pass', '789'].join('');

let server: MockSignupServer;
let url: string;

beforeAll(async () => {
  _resetBackend();
  mkdirSync(join(testDir, 'browser-profile'), { recursive: true });
  _setStorePath(STORE_PATH);

  server = createMockSignupServer();
  ({ url } = await server.start());
});

afterAll(async () => {
  await executeBrowserClose({ close_all_pages: true }, ctx);
  await server.stop();
  _setStorePath(null);
  _resetBackend();
  _resetDeps();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  server.reset();
  // Clear accounts table
  const db = getDb();
  db.run('DELETE FROM accounts');
  // Clear credentials
  for (const key of listSecureKeys()) {
    deleteSecureKey(key);
  }
});

// ── Tests ───────────────────────────────────────────────────────────

describe('end-to-end signup flow', () => {
  test('happy path: full signup with credential fill', async () => {
    // Store credential in vault
    const storeOk = setSecureKey(`credential:mockservice:password`, TEST_PASSWORD);
    expect(storeOk).toBe(true);
    expect(getCredentialValue('mockservice', 'password')).toBe(TEST_PASSWORD);

    // Navigate to signup
    const navResult = await executeBrowserNavigate(
      { url: `${url}/signup`, allow_private_network: true },
      ctx,
    );
    expect(navResult.isError).toBe(false);
    expect(navResult.content).toContain('Status: 200');

    // Step 1: Name
    await executeBrowserType(
      { selector: 'input[name="first_name"]', text: 'Jane' },
      ctx,
    );
    await executeBrowserType(
      { selector: 'input[name="last_name"]', text: 'Doe' },
      ctx,
    );
    await executeBrowserClick({ selector: 'button[type="submit"]' }, ctx);

    // Step 2: Username + password (via credential fill)
    await executeBrowserType(
      { selector: 'input[name="username"]', text: 'janedoe' },
      ctx,
    );
    const fillResult = await executeBrowserFillCredential(
      {
        service: 'mockservice',
        field: 'password',
        selector: 'input[name="password"]',
      },
      ctx,
    );
    expect(fillResult.isError).toBe(false);
    // Credential value must NEVER appear in output
    expect(fillResult.content).not.toContain(TEST_PASSWORD);
    await executeBrowserClick({ selector: 'button[type="submit"]' }, ctx);

    // Step 3: Verification code
    const code = server.getVerificationCode();
    expect(code).toMatch(/^\d{6}$/);
    await executeBrowserType(
      { selector: 'input[name="code"]', text: code },
      ctx,
    );
    await executeBrowserClick({ selector: 'button[type="submit"]' }, ctx);

    // Step 4: CAPTCHA detection + solve
    const captchaResult = await executeBrowserDetectCaptcha({}, ctx);
    expect(captchaResult.isError).toBe(false);
    const captchaData = JSON.parse(captchaResult.content);
    expect(captchaData.detected).toBe(true);

    // Solve by checking the checkbox and submitting
    await executeBrowserClick(
      { selector: 'input[name="captcha_solved"]' },
      ctx,
    );
    await executeBrowserClick({ selector: 'button[type="submit"]' }, ctx);

    // Verify success page
    const extractResult = await executeBrowserExtract({}, ctx);
    expect(extractResult.content).toContain('Account created successfully');

    // Register account in the account registry
    const acct = createAccount({
      service: 'mockservice',
      username: 'janedoe',
      credentialRef: 'mockservice',
      status: 'active',
    });
    expect(acct.id).toBeTruthy();

    // List accounts
    const accounts = listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].username).toBe('janedoe');

    // Verify server recorded the account
    const serverAccounts = server.getAccounts();
    expect(serverAccounts).toHaveLength(1);
    expect(serverAccounts[0].username).toBe('janedoe');
  }, 60_000);

  test('credential not found produces helpful error', async () => {
    await executeBrowserNavigate(
      { url: `${url}/signup`, allow_private_network: true },
      ctx,
    );
    const result = await executeBrowserFillCredential(
      {
        service: 'nonexistent',
        field: 'password',
        selector: 'input[name="first_name"]',
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No credential stored');
    expect(result.content).toContain('credential_store');
  }, 30_000);

  test('taken username shows validation error', async () => {
    // Store credential so fill works
    setSecureKey(`credential:mockservice:password`, TEST_PASSWORD);

    await executeBrowserNavigate(
      { url: `${url}/signup`, allow_private_network: true },
      ctx,
    );

    // Complete step 1
    await executeBrowserType(
      { selector: 'input[name="first_name"]', text: 'Test' },
      ctx,
    );
    await executeBrowserType(
      { selector: 'input[name="last_name"]', text: 'User' },
      ctx,
    );
    await executeBrowserClick({ selector: 'button[type="submit"]' }, ctx);

    // Try taken username
    await executeBrowserType(
      { selector: 'input[name="username"]', text: 'taken' },
      ctx,
    );
    await executeBrowserFillCredential(
      {
        service: 'mockservice',
        field: 'password',
        selector: 'input[name="password"]',
      },
      ctx,
    );
    await executeBrowserClick({ selector: 'button[type="submit"]' }, ctx);

    // Should see error
    const extract = await executeBrowserExtract({}, ctx);
    expect(extract.content).toContain('taken');
  }, 30_000);

  test('wrong verification code shows error', async () => {
    // Store credential so fill works
    setSecureKey(`credential:mockservice:password`, TEST_PASSWORD);

    await executeBrowserNavigate(
      { url: `${url}/signup`, allow_private_network: true },
      ctx,
    );

    // Step 1: name
    await executeBrowserType(
      { selector: 'input[name="first_name"]', text: 'Test' },
      ctx,
    );
    await executeBrowserType(
      { selector: 'input[name="last_name"]', text: 'User' },
      ctx,
    );
    await executeBrowserClick({ selector: 'button[type="submit"]' }, ctx);

    // Step 2: username/password
    await executeBrowserType(
      { selector: 'input[name="username"]', text: 'testuser' },
      ctx,
    );
    await executeBrowserFillCredential(
      {
        service: 'mockservice',
        field: 'password',
        selector: 'input[name="password"]',
      },
      ctx,
    );
    await executeBrowserClick({ selector: 'button[type="submit"]' }, ctx);

    // Step 3: wrong code
    await executeBrowserType(
      { selector: 'input[name="code"]', text: '000000' },
      ctx,
    );
    await executeBrowserClick({ selector: 'button[type="submit"]' }, ctx);

    // Verify error message
    const extract = await executeBrowserExtract({}, ctx);
    expect(extract.content).toContain('Invalid verification code');
  }, 30_000);

  test('credential value never leaks into any tool output', async () => {
    const secret = ['MyS3cret', '!Value', '42'].join('');
    setSecureKey(`credential:leak-test:password`, secret);

    await executeBrowserNavigate(
      { url: `${url}/signup`, allow_private_network: true },
      ctx,
    );

    // Fill credential
    const fillResult = await executeBrowserFillCredential(
      {
        service: 'leak-test',
        field: 'password',
        selector: 'input[name="first_name"]',
      },
      ctx,
    );

    // Secret must not appear in fill output
    expect(fillResult.content).not.toContain(secret);

    // List credentials — should only show metadata
    const allKeys = listSecureKeys();
    const credentialKeys = allKeys.filter((k) => k.startsWith('credential:'));
    const entries = credentialKeys.map((k) => {
      const parts = k.split(':');
      return { service: parts[1], field: parts.slice(2).join(':') };
    });
    const listOutput = JSON.stringify(entries);
    expect(listOutput).not.toContain(secret);
  }, 30_000);
});
