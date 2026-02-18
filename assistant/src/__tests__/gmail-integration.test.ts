import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const toolsManifestPath = resolve(
  __dirname,
  '../config/bundled-skills/messaging/TOOLS.json',
);
const toolsManifest = JSON.parse(readFileSync(toolsManifestPath, 'utf-8'));

describe('Messaging tool contract', () => {
  const expectedGmailToolNames = [
    'gmail_archive',
    'gmail_batch_archive',
    'gmail_label',
    'gmail_batch_label',
    'gmail_trash',
    'gmail_draft',
    'gmail_unsubscribe',
  ];

  const expectedMessagingToolNames = [
    'messaging_auth_test',
    'messaging_list_conversations',
    'messaging_read',
    'messaging_search',
    'messaging_send',
    'messaging_reply',
    'messaging_mark_read',
    'messaging_analyze_activity',
    'messaging_analyze_style',
    'messaging_draft',
  ];

  const expectedSlackToolNames = [
    'slack_add_reaction',
    'slack_leave_channel',
  ];

  test('TOOLS.json manifest contains all expected gmail_* tool names', () => {
    const manifestToolNames: string[] = toolsManifest.tools.map(
      (t: { name: string }) => t.name,
    );
    for (const name of expectedGmailToolNames) {
      expect(manifestToolNames).toContain(name);
    }
  });

  test('TOOLS.json manifest contains all expected messaging_* tool names', () => {
    const manifestToolNames: string[] = toolsManifest.tools.map(
      (t: { name: string }) => t.name,
    );
    for (const name of expectedMessagingToolNames) {
      expect(manifestToolNames).toContain(name);
    }
  });

  test('TOOLS.json manifest contains all expected slack_* tool names', () => {
    const manifestToolNames: string[] = toolsManifest.tools.map(
      (t: { name: string }) => t.name,
    );
    for (const name of expectedSlackToolNames) {
      expect(manifestToolNames).toContain(name);
    }
  });

  test('TOOLS.json manifest tool count matches expected total', () => {
    const expectedTotal = expectedGmailToolNames.length + expectedMessagingToolNames.length + expectedSlackToolNames.length;
    expect(toolsManifest.tools.length).toBe(expectedTotal);
  });
});
