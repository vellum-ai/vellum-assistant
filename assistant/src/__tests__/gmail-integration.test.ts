import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gmailIntegration } from '../integrations/definitions/gmail.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const toolsManifestPath = resolve(
  __dirname,
  '../config/bundled-skills/gmail/TOOLS.json',
);
const toolsManifest = JSON.parse(readFileSync(toolsManifestPath, 'utf-8'));

describe('Gmail integration contract', () => {
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

  test('allowedTools contains all expected gmail_* tool names', () => {
    expect(gmailIntegration.allowedTools).toEqual(expectedToolNames);
  });

  test('allowedTools only contains gmail_* prefixed names', () => {
    for (const name of gmailIntegration.allowedTools) {
      expect(name).toMatch(/^gmail_/);
    }
  });

  test('tool names in integration definition match TOOLS.json manifest', () => {
    const manifestToolNames: string[] = toolsManifest.tools.map(
      (t: { name: string }) => t.name,
    );

    for (const name of gmailIntegration.allowedTools) {
      expect(manifestToolNames).toContain(name);
    }

    for (const name of manifestToolNames) {
      expect(gmailIntegration.allowedTools).toContain(name);
    }
  });

  test('TOOLS.json manifest tool count matches allowedTools count', () => {
    expect(toolsManifest.tools.length).toBe(
      gmailIntegration.allowedTools.length,
    );
  });
});

describe('Gmail OAuth scopes', () => {
  const expectedScopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email',
  ];

  test('OAuth scopes have not changed', () => {
    expect(gmailIntegration.oauth2Config!.scopes).toEqual(expectedScopes);
  });

  test('scopeToolMapping covers exactly the non-userinfo scopes', () => {
    const mappedScopes = Object.keys(gmailIntegration.scopeToolMapping!).sort();
    const nonUserinfoScopes = expectedScopes
      .filter((s) => !s.includes('userinfo'))
      .sort();
    expect(mappedScopes).toEqual(nonUserinfoScopes);
  });

  test('every tool in scopeToolMapping appears in allowedTools', () => {
    const mappedTools = Object.values(gmailIntegration.scopeToolMapping!).flat();
    for (const tool of mappedTools) {
      expect(gmailIntegration.allowedTools).toContain(tool);
    }
  });

  test('union of scope-mapped tools equals allowedTools', () => {
    const mappedTools = new Set(
      Object.values(gmailIntegration.scopeToolMapping!).flat(),
    );
    const allowedSet = new Set(gmailIntegration.allowedTools);
    expect(mappedTools).toEqual(allowedSet);
  });

  test('readonly scope maps to read-only tools', () => {
    const readonlyTools =
      gmailIntegration.scopeToolMapping![
        'https://www.googleapis.com/auth/gmail.readonly'
      ];
    expect(readonlyTools).toEqual([
      'gmail_search',
      'gmail_list_messages',
      'gmail_get_message',
    ]);
  });

  test('modify scope maps to mutation tools', () => {
    const modifyTools =
      gmailIntegration.scopeToolMapping![
        'https://www.googleapis.com/auth/gmail.modify'
      ];
    expect(modifyTools).toEqual([
      'gmail_archive',
      'gmail_batch_archive',
      'gmail_label',
      'gmail_batch_label',
      'gmail_mark_read',
      'gmail_trash',
      'gmail_unsubscribe',
    ]);
  });

  test('send scope maps to draft and send tools', () => {
    const sendTools =
      gmailIntegration.scopeToolMapping![
        'https://www.googleapis.com/auth/gmail.send'
      ];
    expect(sendTools).toEqual(['gmail_draft', 'gmail_send']);
  });
});
