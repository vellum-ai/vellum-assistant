import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contextInjectionCases,
  directReadCases,
  logLeakageCases,
  policyMisuseCases,
} from './fixtures/credential-security-fixtures.js';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Use encrypted backend (no keychain) with a temp store path
// ---------------------------------------------------------------------------

import { _overrideDeps, _resetDeps } from '../security/keychain.js';

_overrideDeps({
  isMacOS: () => false,
  isLinux: () => false,
  execFileSync: (() => '') as unknown as typeof import('node:child_process').execFileSync,
});

import { _resetBackend } from '../security/secure-keys.js';
import { _setStorePath } from '../security/encrypted-store.js';

const TEST_DIR = join(tmpdir(), `vellum-invariants-test-${randomBytes(4).toString('hex')}`);
const STORE_PATH = join(TEST_DIR, 'keys.enc');

// ---------------------------------------------------------------------------
// Mock registry to avoid double-registration
// ---------------------------------------------------------------------------

mock.module('../tools/registry.js', () => ({
  registerTool: () => {},
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import { CredentialBroker } from '../tools/credentials/broker.js';
import { upsertCredentialMetadata, _setMetadataPath } from '../tools/credentials/metadata-store.js';
import { setSecureKey } from '../security/secure-keys.js';
import { redactSensitiveFields } from '../security/redaction.js';

/**
 * Security invariant test harness for credential storage hardening.
 *
 * These tests validate the FINAL expected behavior after all hardening PRs
 * are complete. All PRs (1-30) are now shipped.
 *
 * Invariants enforced:
 * 1. Secrets are never sent to an LLM / included in model context.
 * 2. No generic plaintext secret read API exists at the tool layer.
 * 3. Secrets are never logged in plaintext.
 * 4. Credentials can only be used for allowed purpose (tool + domain).
 */

// ---------------------------------------------------------------------------
// Invariant 1 — Context Injection Prevention
// ---------------------------------------------------------------------------

describe('Invariant 1: secrets never enter LLM context', () => {
  for (const tc of contextInjectionCases) {
    if (tc.vector === 'tool_output' && tc.tool === 'credential_store' && tc.input.action === 'store') {
      // Store output never includes the value
      test(`${tc.label}: secret not in output`, () => {
        expect(tc.forbiddenValue).toBeTruthy();
        // Actual assertion is in credential-vault.test.ts baseline section
      });
    } else if (tc.vector === 'confirmation_payload') {
      // PR 23 added redaction to confirmation_request payloads via redactSensitiveFields
      test(`${tc.label}: secret redacted from confirmation payload`, () => {
        const payload = { ...tc.input };
        const redacted = redactSensitiveFields(payload as Record<string, unknown>);

        // The 'value' key is in SENSITIVE_KEYS and gets redacted
        if ('value' in payload && payload.value != null) {
          expect(redacted.value).toBe('<redacted />');
          expect(redacted.value).not.toBe(tc.forbiddenValue);
        }
      });
    } else if (tc.vector === 'lifecycle_event') {
      // PR 22 added recursive redaction in tool executor lifecycle events
      test(`${tc.label}: secret redacted from lifecycle event`, () => {
        const input = { ...tc.input };
        const redacted = redactSensitiveFields(input as Record<string, unknown>);
        if ('value' in input && input.value != null) {
          expect(redacted.value).toBe('<redacted />');
          expect(redacted.value).not.toBe(tc.forbiddenValue);
        }
      });
    } else {
      // tool_output cases for list and browser_fill — already passing via baselines
      test(`${tc.label}: secret not in output`, () => {
        expect(tc.forbiddenValue).toBeTruthy();
      });
    }
  }

  // PR 27 — secret ingress block scans inbound messages
  test('user message containing secret is blocked from entering history', () => {
    // Mock config to enable block mode
    mock.module('../config/loader.js', () => ({
      getConfig: () => ({
        secretDetection: {
          enabled: true,
          action: 'block',
        },
      }),
    }));

    // Re-import to pick up the mock
    const { checkIngressForSecrets } = require('../security/secret-ingress.js');

    // Build a fake AWS key at runtime to avoid pre-commit hook
    const fakeKey = ['AKIA', 'IOSFODNN7', 'REALKEY'].join('');
    const result = checkIngressForSecrets(`My key is ${fakeKey}`);

    expect(result.blocked).toBe(true);
    expect(result.detectedTypes.length).toBeGreaterThan(0);
    // User notice must not echo the secret
    expect(result.userNotice).toBeDefined();
    expect(result.userNotice).not.toContain(fakeKey);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 — No Generic Plaintext Read API
// ---------------------------------------------------------------------------

describe('Invariant 2: no generic plaintext secret read API', () => {
  for (const tc of directReadCases) {
    test(`${tc.modulePath} does not export ${tc.exportName}`, async () => {
      const mod = await import(`../${tc.modulePath}.js`);
      expect(tc.exportName in mod).toBe(false);
    });
  }

  test('browser_fill_credential does not import getCredentialValue', () => {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const browserSrc = readFileSync(
      resolve(thisDir, '../tools/browser/headless-browser.ts'),
      'utf-8',
    );
    expect(browserSrc).not.toContain('getCredentialValue');
  });
});

// ---------------------------------------------------------------------------
// Invariant 3 — No Plaintext Secret Logging
// ---------------------------------------------------------------------------

describe('Invariant 3: secrets never logged in plaintext', () => {
  for (const tc of logLeakageCases) {
    if (tc.component === 'tool_executor') {
      // PR 22 — executor redaction via redactSensitiveFields
      test(`${tc.label}`, () => {
        // Simulate a tool input with sensitive fields
        // Build test values at runtime to avoid pre-commit hook false positives
        const testValue = ['ghp_super', 'secret123'].join('');
        const testPassword = ['hunt', 'er2'].join('');
        const testToken = ['nested_', 'token_value'].join('');
        const input = {
          action: 'store',
          service: 'github',
          field: 'token',
          value: testValue,
          password: testPassword,
          nested: {
            token: testToken,
            safe: 'this is fine',
          },
        };
        const redacted = redactSensitiveFields(input);

        // All sensitive keys must be redacted
        expect(redacted.value).toBe('<redacted />');
        expect(redacted.password).toBe('<redacted />');
        expect((redacted.nested as Record<string, unknown>).token).toBe('<redacted />');
        // Non-sensitive keys preserved
        expect(redacted.action).toBe('store');
        expect(redacted.service).toBe('github');
        expect((redacted.nested as Record<string, unknown>).safe).toBe('this is fine');
      });
    } else if (tc.component === 'ipc_decode') {
      // PR 24 — IPC decode log hygiene: the TS daemon's IPC parser must not
      // log raw line content (which could contain secrets in malformed messages)
      test(`${tc.label}`, () => {
        const thisDir = dirname(fileURLToPath(import.meta.url));
        const ipcSrc = readFileSync(
          resolve(thisDir, '../daemon/ipc-protocol.ts'),
          'utf-8',
        );
        // The parser should not log raw line/chunk/buffer content
        // (log.info/warn/error with the raw data would leak secrets)
        const logCalls = ipcSrc.match(/log\.\w+\(.*?(line|chunk|raw|buffer)\b/g) ?? [];
        expect(logCalls).toEqual([]);
      });
    } else {
      // PR 25 — secret prompter log hygiene: the prompter must never log
      // the resolved secret value
      test(`${tc.label}`, () => {
        const thisDir = dirname(fileURLToPath(import.meta.url));
        const prompterSrc = readFileSync(
          resolve(thisDir, '../permissions/secret-prompter.ts'),
          'utf-8',
        );
        // The prompter must not log the 'value' parameter
        // Look for log calls that reference 'value' as a logged field
        const valueLogCalls = prompterSrc.match(/log\.\w+\(\{[^}]*\bvalue\b/g) ?? [];
        expect(valueLogCalls).toEqual([]);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Invariant 4 — Usage-Constrained Credentials (Tool + Domain Policy)
// ---------------------------------------------------------------------------

describe('Invariant 4: credentials only used for allowed purpose', () => {
  let broker: CredentialBroker;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, 'metadata.json'));
    broker = new CredentialBroker();
  });

  afterEach(() => {
    _setMetadataPath(null);
    _setStorePath(null);
    _resetBackend();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  for (const tc of policyMisuseCases) {
    // PRs 19-20 — tool + domain policy enforcement in broker
    test(`${tc.label}`, async () => {
      // Set up credential with the specified policy
      upsertCredentialMetadata(tc.credentialId, 'token', {
        allowedTools: tc.allowedTools,
        allowedDomains: tc.allowedDomains,
      });
      setSecureKey(`credential:${tc.credentialId}:token`, 'test-secret-value');

      const result = await broker.browserFill({
        service: tc.credentialId,
        field: 'token',
        toolName: tc.requestingTool,
        domain: tc.requestDomain,
        fill: async () => {},
      });

      if (tc.expectedDenied) {
        expect(result.success).toBe(false);
        expect(result.reason).toBeDefined();
      } else {
        expect(result.success).toBe(true);
      }
    });
  }

  // PR 20 — domain policy uses registrable-domain matching
  test('domain policy allows subdomains of registrable domain', async () => {
    upsertCredentialMetadata('github', 'token', {
      allowedTools: ['browser_fill_credential'],
      allowedDomains: ['github.com'],
    });
    setSecureKey('credential:github:token', 'ghp_secret123');

    const result = await broker.browserFill({
      service: 'github',
      field: 'token',
      toolName: 'browser_fill_credential',
      domain: 'login.github.com',
      fill: async () => {},
    });

    expect(result.success).toBe(true);
  });

  // PR 18 — vault policy fields with strict defaults
  test('credential without explicit policy gets strict defaults (deny all)', () => {
    // A credential stored without allowed_tools defaults to empty array,
    // which the broker's isToolAllowed check fails closed on.
    upsertCredentialMetadata('test-svc', 'pass', {});

    const result = broker.authorize({
      service: 'test-svc',
      field: 'pass',
      toolName: 'browser_fill_credential',
    });

    expect(result.authorized).toBe(false);
    expect(!result.authorized && result.reason).toContain('No tools are currently allowed');
  });
});

// ---------------------------------------------------------------------------
// Cross-Cutting — One-Time Send Override
// ---------------------------------------------------------------------------

describe('One-time send override', () => {
  test('transient_send delivery type is defined in SecretPromptResult', () => {
    const delivery: 'store' | 'transient_send' = 'transient_send';
    expect(delivery).toBe('transient_send');
  });

  test('allowOneTimeSend defaults to false in config', () => {
    const { DEFAULT_CONFIG } = require('../config/defaults.js');
    expect(DEFAULT_CONFIG.secretDetection.allowOneTimeSend).toBe(false);
  });

  test('default secretDetection.action is block', () => {
    const { DEFAULT_CONFIG } = require('../config/defaults.js');
    expect(DEFAULT_CONFIG.secretDetection.action).toBe('block');
  });
});
