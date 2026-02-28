import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { DAEMON_INTERNAL_ASSISTANT_ID } from '../runtime/assistant-scope.js';

/**
 * Guard tests for the assistant identity boundary.
 *
 * The daemon uses a fixed internal scope constant (`DAEMON_INTERNAL_ASSISTANT_ID`)
 * for all assistant-scoped storage. Public assistant IDs are an edge concern
 * handled by the gateway/platform layer — they must not leak into daemon
 * scoping logic.
 *
 * These tests prevent regressions by scanning source files for banned patterns:
 *  - No `normalizeAssistantId` usage in daemon/runtime scoping modules
 *  - No assistant-scoped route handlers in the daemon HTTP server
 *  - No hardcoded `'self'` string for assistant scoping (use the constant)
 *  - The constant itself equals `'self'`
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve repo root (tests run from assistant/). */
function getRepoRoot(): string {
  return join(process.cwd(), '..');
}

/**
 * Directories containing daemon/runtime source files that must not reference
 * `normalizeAssistantId` or hardcode assistant scope strings.
 *
 * Each directory gets both a `*.ts` glob (top-level files) and a `**\/*.ts`
 * glob (nested files) so that `git grep` matches at all directory depths.
 */
const SCANNED_DIRS = [
  'assistant/src/runtime',
  'assistant/src/daemon',
  'assistant/src/memory',
  'assistant/src/approvals',
  'assistant/src/calls',
  'assistant/src/tools',
];

const SCANNED_DIR_GLOBS = SCANNED_DIRS.flatMap((dir) => [`${dir}/*.ts`, `${dir}/**/*.ts`]);

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('/__tests__/') ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.js') ||
    filePath.endsWith('.spec.ts') ||
    filePath.endsWith('.spec.js')
  );
}

function isMigrationFile(filePath: string): boolean {
  return filePath.includes('/migrations/');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assistant ID boundary', () => {
  // -------------------------------------------------------------------------
  // Rule (d): The DAEMON_INTERNAL_ASSISTANT_ID constant equals 'self'
  // -------------------------------------------------------------------------

  test('DAEMON_INTERNAL_ASSISTANT_ID equals "self"', () => {
    expect(DAEMON_INTERNAL_ASSISTANT_ID).toBe('self');
  });

  // -------------------------------------------------------------------------
  // Rule (a): No normalizeAssistantId in daemon scoping paths — spot check
  // -------------------------------------------------------------------------

  test('no normalizeAssistantId imports in daemon scoping paths', () => {
    // Key daemon/runtime files that previously used normalizeAssistantId
    // should now use DAEMON_INTERNAL_ASSISTANT_ID instead.
    const daemonScopingFiles = [
      'runtime/actor-trust-resolver.ts',
      'runtime/guardian-outbound-actions.ts',
      'daemon/handlers/config-channels.ts',
      'runtime/routes/channel-route-shared.ts',
      'calls/relay-server.ts',
    ];

    const srcDir = join(import.meta.dir, '..');
    for (const relPath of daemonScopingFiles) {
      const content = readFileSync(join(srcDir, relPath), 'utf-8');
      expect(content).not.toContain("import { normalizeAssistantId }");
      expect(content).not.toContain("import { normalizeAssistantId,");
      expect(content).not.toContain("normalizeAssistantId(");
    }
  });

  // -------------------------------------------------------------------------
  // Rule (a): No normalizeAssistantId in daemon/runtime directories — broad scan
  // -------------------------------------------------------------------------

  test('no normalizeAssistantId usage across daemon/runtime source directories', () => {
    const repoRoot = getRepoRoot();

    // Scan all daemon/runtime source directories for any reference to
    // normalizeAssistantId. The function is defined in util/platform.ts for
    // gateway use — it must not appear in daemon scoping modules.
    let grepOutput = '';
    try {
      grepOutput = execFileSync(
        'git',
        ['grep', '-lE', 'normalizeAssistantId', '--', ...SCANNED_DIR_GLOBS],
        { encoding: 'utf-8', cwd: repoRoot },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const files = grepOutput.split('\n').filter((f) => f.length > 0);
    const violations = files.filter((f) => !isTestFile(f));

    if (violations.length > 0) {
      const message = [
        'Found daemon/runtime source files that reference `normalizeAssistantId`.',
        'Daemon code should use the `DAEMON_INTERNAL_ASSISTANT_ID` constant instead.',
        'The `normalizeAssistantId` function is for gateway/platform use only (defined in util/platform.ts).',
        '',
        'Violations:',
        ...violations.map((f) => `  - ${f}`),
      ].join('\n');

      expect(violations, message).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // Rule (b): No assistant-scoped route registration in daemon HTTP server
  // -------------------------------------------------------------------------

  test('no /v1/assistants/:assistantId/ route handler registration in daemon HTTP server', () => {
    const httpServerPath = join(import.meta.dir, '..', 'runtime', 'http-server.ts');
    const content = readFileSync(httpServerPath, 'utf-8');

    // The transitional rewrite in dispatchEndpoint is acceptable — it strips
    // the assistant-scoped prefix and recurses. What we guard against is a
    // regex that extracts an assistantId for routing purposes, like:
    //   /^\/v1\/assistants\/([^/]+)\/(.+)$/
    // which would mean the server is treating the assistantId as meaningful.

    // Check that there's no regex extracting assistantId from a /v1/assistants/ path
    // for use as a route handler (as opposed to the rewrite pattern).
    // Match both literal slashes (/v1/assistants/([) and escaped slashes in regex
    // literals (\/v1\/assistants\/([) so we catch patterns like:
    //   endpoint.match(/^\/v1\/assistants\/([^/]+)\/(.+)$/)
    const routeHandlerRegex = /\\?\/v1\\?\/assistants\\?\/\(\[/;
    const match = content.match(routeHandlerRegex);
    expect(
      match,
      'Found a route pattern matching /v1/assistants/([^/]+)/... that extracts an assistantId. ' +
        'The daemon HTTP server should not have assistant-scoped route handlers — ' +
        'use flat /v1/<endpoint> paths instead. The transitional rewrite in dispatchEndpoint ' +
        'is the only acceptable place for the assistants/ prefix.',
    ).toBeNull();

    // Also verify that the routeRequest method does not contain a direct
    // /v1/assistants/ route match (i.e., the pattern is only in dispatchEndpoint
    // as a rewrite, not in routeRequest as a handler).
    const lines = content.split('\n');
    let inRouteRequest = false;
    const routeRequestViolations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('private async routeRequest(')) {
        inRouteRequest = true;
      }
      if (inRouteRequest && lines[i].includes('private async handleAuthenticatedRequest(')) {
        // Moved past routeRequest into the next method
        break;
      }
      if (inRouteRequest && lines[i].includes('/v1/assistants/')) {
        routeRequestViolations.push(`  line ${i + 1}: ${lines[i].trim()}`);
      }
    }

    expect(
      routeRequestViolations,
      'Found /v1/assistants/ references in routeRequest — this method should not ' +
        'handle assistant-scoped paths directly.\n' +
        routeRequestViolations.join('\n'),
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Rule (c): No hardcoded 'self' for assistant scoping in daemon files
  // -------------------------------------------------------------------------

  test('no hardcoded \'self\' string for assistant scoping in daemon source files', () => {
    const repoRoot = getRepoRoot();

    // Search for patterns where 'self' is used as an assistant ID value.
    // We look for assignment / default / comparison patterns that suggest
    // using the raw string instead of the DAEMON_INTERNAL_ASSISTANT_ID constant.
    //
    // Patterns matched:
    //   assistantId: 'self'
    //   assistantId = 'self'
    //   assistantId ?? 'self'
    //   ?? 'self'   (fallback to self)
    //   || 'self'   (fallback to self)
    //
    // Excluded:
    //   - Test files (they may legitimately assert against the value)
    //   - Migration files (SQL literals like DEFAULT 'self' are fine)
    //   - IPC contract files (comments documenting default values are fine)
    //   - CSP headers ('self' in Content-Security-Policy has nothing to do with assistant IDs)
    const pattern = `(assistantId|assistant_id).*['"]self['"]`;

    let grepOutput = '';
    try {
      grepOutput = execFileSync(
        'git',
        ['grep', '-nE', pattern, '--', ...SCANNED_DIR_GLOBS],
        { encoding: 'utf-8', cwd: repoRoot },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const lines = grepOutput.split('\n').filter((l) => l.length > 0);
    const violations = lines.filter((line) => {
      const filePath = line.split(':')[0];
      if (isTestFile(filePath)) return false;
      if (isMigrationFile(filePath)) return false;

      // Allow comments (lines where the code portion starts with //)
      const parts = line.split(':');
      // parts[0] = file, parts[1] = line number, rest = content
      const content = parts.slice(2).join(':').trim();
      if (content.startsWith('//') || content.startsWith('*') || content.startsWith('/*')) {
        return false;
      }

      return true;
    });

    if (violations.length > 0) {
      const message = [
        "Found daemon/runtime source files with hardcoded 'self' for assistant scoping.",
        'Use the `DAEMON_INTERNAL_ASSISTANT_ID` constant from `runtime/assistant-scope.ts` instead.',
        '',
        'Violations:',
        ...violations.map((v) => `  - ${v}`),
      ].join('\n');

      expect(violations, message).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // Rule (d): Daemon storage keys don't contain external assistant IDs
  // (verified by the constant value test above — if the constant is 'self',
  // all daemon storage keyed by DAEMON_INTERNAL_ASSISTANT_ID uses the fixed
  // internal value rather than externally-provided IDs).
  // -------------------------------------------------------------------------
});
