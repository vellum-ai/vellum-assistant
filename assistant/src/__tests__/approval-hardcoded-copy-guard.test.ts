/**
 * Guard test: ensures no production hard-coded approval lifecycle copy creeps
 * back into route/service files outside of the composer module.
 *
 * The composer file (`approval-message-composer.ts`) is intentionally excluded
 * since that is where deterministic fallback copy legitimately lives.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, test, expect } from 'bun:test';

const SCANNED_FILES = [
  'runtime/channel-approvals.ts',
  'runtime/routes/channel-routes.ts',
  'runtime/channel-guardian-service.ts',
];

const BANNED_PATTERNS: { pattern: RegExp; description: string }[] = [
  { pattern: /The assistant wants to use/i, description: 'old standard prompt' },
  { pattern: /Do you want to allow this/i, description: 'old approval question' },
  { pattern: /['"`]I'm still waiting/i, description: 'old reminder prefix (string literal)' },
  { pattern: /['"`].*is requesting to run/i, description: 'old guardian prompt (string literal)' },
  { pattern: /['"`]Sent to guardian/i, description: 'old forwarding notice (string literal)' },
  { pattern: /['"`]Guardian verified successfully/i, description: 'old verify success (string literal)' },
  { pattern: /['"`]Verification failed/i, description: 'old verify failure (string literal)' },
  { pattern: /['"`]Your request has been sent/i, description: 'old request forwarded notice (string literal)' },
  { pattern: /['"`]No guardian is configured/i, description: 'old no-binding notice (string literal)' },
];

describe('approval hardcoded copy guard', () => {
  for (const file of SCANNED_FILES) {
    test(`${file} does not contain banned approval copy literals`, () => {
      const content = readFileSync(join(__dirname, '..', file), 'utf-8');
      for (const { pattern, description } of BANNED_PATTERNS) {
        const match = content.match(pattern);
        expect(match).toBeNull();
      }
    });
  }
});
