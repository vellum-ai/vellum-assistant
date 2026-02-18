import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const toolsManifestPath = resolve(
  __dirname,
  '../config/bundled-skills/gmail/TOOLS.json',
);
const toolsManifest = JSON.parse(readFileSync(toolsManifestPath, 'utf-8'));

describe('Gmail tool contract', () => {
  const expectedToolNames = [
    'gmail_search',
    'gmail_list_messages',
    'gmail_get_message',
    'gmail_archive',
    'gmail_batch_archive',
    'gmail_label',
    'gmail_batch_label',
    'gmail_mark_read',
    'gmail_trash',
    'gmail_draft',
    'gmail_send',
    'gmail_unsubscribe',
  ];

  test('TOOLS.json manifest contains all expected gmail_* tool names', () => {
    const manifestToolNames: string[] = toolsManifest.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(manifestToolNames.sort()).toEqual(expectedToolNames.sort());
  });

  test('TOOLS.json manifest only contains gmail_* prefixed names', () => {
    for (const tool of toolsManifest.tools) {
      expect(tool.name).toMatch(/^gmail_/);
    }
  });

  test('TOOLS.json manifest tool count matches expected', () => {
    expect(toolsManifest.tools.length).toBe(expectedToolNames.length);
  });
});
