import { describe, test, expect } from 'bun:test';
import { isToolAllowed } from '../tools/credentials/tool-policy.js';

describe('isToolAllowed', () => {
  // ── Allow cases ─────────────────────────────────────────────────────

  test('allows tool listed in allowedTools', () => {
    expect(isToolAllowed('browser_fill_credential', ['browser_fill_credential'])).toBe(true);
  });

  test('allows tool when multiple tools are listed', () => {
    expect(isToolAllowed('bash', ['browser_fill_credential', 'bash', 'web_fetch'])).toBe(true);
  });

  // ── Deny cases ──────────────────────────────────────────────────────

  test('denies tool not in allowedTools', () => {
    expect(isToolAllowed('bash', ['browser_fill_credential'])).toBe(false);
  });

  test('denies when allowedTools is empty', () => {
    expect(isToolAllowed('browser_fill_credential', [])).toBe(false);
  });

  test('denies when allowedTools is undefined', () => {
    expect(isToolAllowed('browser_fill_credential', undefined as unknown as string[])).toBe(false);
  });

  test('denies when toolName is empty', () => {
    expect(isToolAllowed('', ['browser_fill_credential'])).toBe(false);
  });

  test('denies when toolName is not a string', () => {
    expect(isToolAllowed(null as unknown as string, ['browser_fill_credential'])).toBe(false);
  });

  // ── Exact match (no wildcards) ──────────────────────────────────────

  test('requires exact match — no prefix matching', () => {
    expect(isToolAllowed('browser_fill', ['browser_fill_credential'])).toBe(false);
  });

  test('requires exact match — no suffix matching', () => {
    expect(isToolAllowed('browser_fill_credential_v2', ['browser_fill_credential'])).toBe(false);
  });

  test('match is case-sensitive', () => {
    expect(isToolAllowed('Browser_Fill_Credential', ['browser_fill_credential'])).toBe(false);
  });
});
