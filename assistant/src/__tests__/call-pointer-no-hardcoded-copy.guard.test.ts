/**
 * Guard test: prevent reintroduction of hard-coded pointer copy in
 * relay-server.ts, call-controller.ts, and call-domain.ts.
 *
 * Deterministic fallback literals should only exist in the pointer
 * composer file (call-pointer-message-composer.ts). The call-site
 * files should route through addPointerMessage() exclusively.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const srcDir = join(import.meta.dir, '..');

// These files must NOT contain inline pointer copy strings.
const guardedFiles = [
  'calls/relay-server.ts',
  'calls/call-controller.ts',
  'calls/call-domain.ts',
];

// Patterns that indicate inline pointer copy rather than routing through
// addPointerMessage. We check for the distinctive emoji + "Call to" prefix
// that the old hard-coded templates used.
const forbiddenPatterns = [
  /["\u{1F4DE}].*Call to.*(?:started|completed|failed)/u,
  /["\u{2705}].*Guardian verification.*succeeded/u,
  /["\u{274C}].*Guardian verification.*failed/u,
];

describe('no hardcoded pointer copy in call-site files', () => {
  for (const file of guardedFiles) {
    test(`${file} does not contain inline pointer copy`, () => {
      const content = readFileSync(join(srcDir, file), 'utf-8');
      for (const pattern of forbiddenPatterns) {
        const match = pattern.exec(content);
        expect(match).toBeNull();
      }
    });
  }
});
