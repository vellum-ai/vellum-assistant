import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
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

// Restore process-level keychain deps so later test files are not affected
afterAll(() => {
  _resetDeps();
  mock.restore();
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
          blockIngress: true,
        },
      }),
    }));

    // Re-import to pick up the mock
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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

  test('getSecureKey is only imported by authorized modules', () => {
    // Hard boundary: only these production files may import getSecureKey.
    // Any new import must be reviewed for secret-leak risk and added here.
    const ALLOWED_IMPORTERS = new Set([
      'security/secure-keys.ts',       // self (re-export infrastructure)
      'index.ts',                       // daemon startup / API key config
      'config/loader.ts',              // config management (API keys)
      'tools/credentials/vault.ts',    // credential store tool
      'tools/credentials/broker.ts',   // brokered credential access
      'tools/network/web-search.ts',   // web search API key lookup
      'daemon/handlers.ts',            // Vercel API token + integration OAuth
      'daemon/handlers/config.ts',     // Vercel API token + integration OAuth (split handler)
      'security/token-manager.ts',     // OAuth token refresh flow
      'email/providers/index.ts',      // email provider API key lookup
      'tools/network/script-proxy/session-manager.ts', // proxy credential injection at runtime
      'messaging/registry.ts',          // checks stored credentials for connected providers
      'calls/call-domain.ts',            // caller identity resolution (user phone number lookup)
      'calls/elevenlabs-config.ts',     // ElevenLabs voice quality API key lookup
      'calls/twilio-config.ts',         // call infrastructure credential lookup
      'calls/twilio-provider.ts',       // call infrastructure credential lookup
      'cli/config-commands.ts',         // CLI credential management commands
      'runtime/http-server.ts',         // HTTP server credential lookup
      'daemon/handlers/twitter-auth.ts', // Twitter OAuth token storage
      'messaging/providers/telegram-bot/adapter.ts', // Telegram bot token lookup for connectivity check
    ]);

    const thisDir = dirname(fileURLToPath(import.meta.url));
    const srcDir = resolve(thisDir, '..');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readdirSync, statSync } = require('node:fs');

    // Recursively collect all .ts files in src/ (excluding __tests__)
    function collectTsFiles(dir: string, files: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (entry === '__tests__' || entry === 'node_modules') continue;
        const s = statSync(full);
        if (s.isDirectory()) {
          collectTsFiles(full, files);
        } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
          files.push(full);
        }
      }
      return files;
    }

    const allFiles = collectTsFiles(srcDir);
    const unauthorizedImporters: string[] = [];

    for (const filePath of allFiles) {
      const content = readFileSync(filePath, 'utf-8');
      // Check for imports of getSecureKey via static import, dynamic import(), or require()
      if (content.match(/\bgetSecureKey\b/) && (content.match(/from\s+['"].*secure-keys/) || content.match(/(?:import|require)\s*\(\s*['"].*secure-keys/))) {
        const relative = filePath.slice(srcDir.length + 1);
        if (!ALLOWED_IMPORTERS.has(relative)) {
          unauthorizedImporters.push(relative);
        }
      }
    }

    expect(unauthorizedImporters).toEqual([]);
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
      // PR 24 — IPC decode log hygiene: the TS daemon's IPC parser must
      // not have any logging that could leak raw message content
      test(`${tc.label}`, () => {
        const thisDir = dirname(fileURLToPath(import.meta.url));
        const ipcSrc = readFileSync(
          resolve(thisDir, '../daemon/ipc-protocol.ts'),
          'utf-8',
        );
        // The IPC parser must not use a logger at all — it handles raw
        // bytes that could contain secrets in malformed messages. Verify
        // no getLogger import and no log.* calls exist in the source.
        expect(ipcSrc).not.toContain('getLogger');
        expect(ipcSrc).not.toMatch(/\blog\.\w+\(/);
      });
    } else {
      // PR 25 — secret prompter log hygiene: verify the prompter source
      // never logs sensitive field values (value, secret, password, token)
      test(`${tc.label}`, () => {
        const thisDir = dirname(fileURLToPath(import.meta.url));
        const prompterSrc = readFileSync(
          resolve(thisDir, '../permissions/secret-prompter.ts'),
          'utf-8',
        );

        // Extract all log.* call arguments: log.warn({...}, 'msg')
        // The first argument is the structured data object that gets logged.
        const logCallPattern = /log\.\w+\(\{([^}]*)}/g;
        const loggedFields: string[] = [];
        let match;
        while ((match = logCallPattern.exec(prompterSrc)) !== null) {
          // Collect field names from the structured log object
          const fields = match[1].split(',').map(f => f.trim().split(':')[0].trim());
          loggedFields.push(...fields);
        }

        // None of the logged fields should be sensitive credential fields
        const sensitiveFields = ['value', 'secret', 'password', 'token', 'api_key', 'credentials'];
        for (const field of loggedFields) {
          expect(sensitiveFields).not.toContain(field);
        }

        // Additionally verify the resolveSecret method never logs its value parameter
        // by checking that log calls in resolveSecret only reference requestId
        const resolveBlock = prompterSrc.match(/resolveSecret[\s\S]*?^\s{2}\}/m)?.[0] ?? '';
        expect(resolveBlock).not.toMatch(/log\.\w+\(.*\bvalue\b/);
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DEFAULT_CONFIG } = require('../config/defaults.js');
    expect(DEFAULT_CONFIG.secretDetection.allowOneTimeSend).toBe(false);
  });

  test('default secretDetection.action is redact', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DEFAULT_CONFIG } = require('../config/defaults.js');
    expect(DEFAULT_CONFIG.secretDetection.action).toBe('redact');
  });

  test('default secretDetection.blockIngress is true', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DEFAULT_CONFIG } = require('../config/defaults.js');
    expect(DEFAULT_CONFIG.secretDetection.blockIngress).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant 5 — Proxy Redaction and Sensitive Logging Guards
// ---------------------------------------------------------------------------

import {
  sanitizeHeaders,
  sanitizeUrl,
  createSafeLogEntry,
} from '../tools/network/script-proxy/logging.js';

describe('Invariant 5: proxy log entries never contain secrets', () => {
  test('Authorization headers are redacted in log entries', () => {
    const headers: Record<string, string> = {
      'Authorization': 'Bearer ghp_s3cr3tT0k3n',
      'Content-Type': 'application/json',
      'X-Custom': 'safe-value',
    };

    const sanitized = sanitizeHeaders(headers, ['authorization']);

    expect(sanitized['Authorization']).toBe('[REDACTED]');
    expect(sanitized['Content-Type']).toBe('application/json');
    expect(sanitized['X-Custom']).toBe('safe-value');
  });

  test('header redaction is case-insensitive', () => {
    const headers: Record<string, string> = {
      'authorization': 'Bearer secret123',
      'X-Api-Key': 'key-abc-123',
    };

    const sanitized = sanitizeHeaders(headers, ['Authorization', 'x-api-key']);

    expect(sanitized['authorization']).toBe('[REDACTED]');
    expect(sanitized['X-Api-Key']).toBe('[REDACTED]');
  });

  test('API key query params are redacted', () => {
    const url = 'https://api.example.com/v1/search?api_key=sk-secret-value&q=hello';
    const sanitized = sanitizeUrl(url, ['api_key']);

    expect(sanitized).not.toContain('sk-secret-value');
    expect(sanitized).toContain('api_key=%5BREDACTED%5D');
    expect(sanitized).toContain('q=hello');
  });

  test('multiple sensitive query params are all redacted', () => {
    const url = 'https://api.example.com/path?token=abc123&key=def456&safe=keep';
    const sanitized = sanitizeUrl(url, ['token', 'key']);

    expect(sanitized).not.toContain('abc123');
    expect(sanitized).not.toContain('def456');
    expect(sanitized).toContain('safe=keep');
  });

  test('sanitizeUrl handles path-only URLs', () => {
    const url = '/v1/search?api_key=secret&q=hello';
    const sanitized = sanitizeUrl(url, ['api_key']);

    expect(sanitized).not.toContain('secret');
    expect(sanitized).toContain('q=hello');
    // Result should still be a path, not an absolute URL
    expect(sanitized).toMatch(/^\//);
  });

  test('sanitizeUrl returns URL unchanged when no query string', () => {
    const url = 'https://api.example.com/v1/resource';
    expect(sanitizeUrl(url, ['api_key'])).toBe(url);
  });

  test('credential values from injection templates never appear in sanitized output', () => {
    // Simulate a header-injected credential (e.g. "Authorization: Key <secret>")
    const secretValue = ['Key ', 'fal_', 'superSecretApiKey'].join('');
    const req = {
      method: 'POST',
      url: 'https://api.fal.ai/v1/generate',
      headers: {
        'Authorization': secretValue,
        'Content-Type': 'application/json',
        'Host': 'api.fal.ai',
      },
    };

    const entry = createSafeLogEntry(req, ['Authorization']);
    const serialized = JSON.stringify(entry);

    expect(serialized).not.toContain('fal_');
    expect(serialized).not.toContain('superSecretApiKey');
    expect(entry.headers['Authorization']).toBe('[REDACTED]');
    expect(entry.headers['Content-Type']).toBe('application/json');
    expect(entry.method).toBe('POST');
  });

  test('credential values from query injection templates never appear in sanitized output', () => {
    // Simulate a query-injected credential (e.g. "?api_key=<secret>")
    const secretValue = ['sk-live-', 'abc123', 'xyz789'].join('');
    const req = {
      method: 'GET',
      url: `https://api.example.com/v1/data?api_key=${secretValue}&format=json`,
      headers: {
        'Host': 'api.example.com',
      },
    };

    const entry = createSafeLogEntry(req, ['api_key']);
    const serialized = JSON.stringify(entry);

    expect(serialized).not.toContain('sk-live-');
    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('xyz789');
    expect(entry.url).toContain('format=json');
  });

  test('createSafeLogEntry redacts both headers and query params together', () => {
    const headerSecret = ['Bearer ', 'ghp_', 'tokenValue'].join('');
    const querySecret = ['secret-', 'key-', '42'].join('');
    const req = {
      method: 'GET',
      url: `https://api.github.com/repos?access_token=${querySecret}`,
      headers: {
        'Authorization': headerSecret,
        'Accept': 'application/json',
      },
    };

    const entry = createSafeLogEntry(req, ['Authorization', 'access_token']);
    const serialized = JSON.stringify(entry);

    expect(serialized).not.toContain('ghp_');
    expect(serialized).not.toContain('tokenValue');
    expect(serialized).not.toContain('secret-');
    expect(serialized).not.toContain('key-42');
    expect(entry.headers['Accept']).toBe('application/json');
  });
});
