import { describe, expect, test } from 'bun:test';

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

  test.todo('no normalizeAssistantId in daemon scoping paths');

  test.todo('daemon storage keys never contain external assistant IDs');
});
