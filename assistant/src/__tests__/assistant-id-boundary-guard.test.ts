import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DAEMON_INTERNAL_ASSISTANT_ID } from '../runtime/assistant-scope.js';

/**
 * Guard tests for the assistant identity boundary.
 *
 * The daemon uses a fixed internal scope constant (`DAEMON_INTERNAL_ASSISTANT_ID`)
 * for all assistant-scoped storage. Public assistant IDs are an edge concern
 * handled by the gateway/platform layer — they must not leak into daemon
 * scoping logic.
 */
describe('assistant ID boundary', () => {
  test('DAEMON_INTERNAL_ASSISTANT_ID equals "self"', () => {
    expect(DAEMON_INTERNAL_ASSISTANT_ID).toBe('self');
  });

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

  test.todo('daemon storage keys never contain external assistant IDs');
});
