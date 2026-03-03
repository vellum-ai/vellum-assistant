import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * Guard test: bundled skills must not contain patterns that require
 * reading plaintext secrets back from secure storage or credential vault.
 *
 * These anti-patterns leak secrets into conversation context:
 * - `credential_store action=get` — unsupported action that reads plaintext
 * - `<value from credential_store ...>` or `<api_key_from_credential_store>` — plaintext placeholders
 * - Direct keychain retrieval commands targeting credential keys
 *
 * Instead, skills should:
 * - Use `credential_store action=prompt` to collect credentials securely
 * - Call server-side endpoints that resolve credentials from secure storage
 */

const BUNDLED_SKILLS_DIR = join(import.meta.dir, '..', 'config', 'bundled-skills');

/** Recursively collect all .md files under a directory. */
function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectMarkdownFiles(full));
    } else if (entry.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

const skillFiles = collectMarkdownFiles(BUNDLED_SKILLS_DIR);

describe('bundled skills credential readback guard', () => {
  test('no bundled skills use credential_store action=get', () => {
    const violations: string[] = [];
    for (const file of skillFiles) {
      const content = readFileSync(file, 'utf-8');
      // Match credential_store with action=get (with or without quotes, flexible whitespace)
      if (/credential_store\s+[^]*?action\s*=\s*"?get"?/i.test(content)) {
        const rel = file.replace(BUNDLED_SKILLS_DIR + '/', '');
        violations.push(rel);
      }
    }
    expect(
      violations,
      `Bundled skills must not use \`credential_store action=get\` — ` +
      `this reads plaintext secrets into conversation context. ` +
      `Use server-side endpoints that resolve credentials from secure storage instead.\n` +
      `Violations:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    ).toEqual([]);
  });

  test('no bundled skills use plaintext credential placeholders', () => {
    const violations: string[] = [];
    // Match patterns like <value from credential_store ...> or <api_key_from_credential_store>
    const placeholderPattern = /<[^>]*(?:from\s+credential_store|credential_store)[^>]*>/i;
    for (const file of skillFiles) {
      const content = readFileSync(file, 'utf-8');
      if (placeholderPattern.test(content)) {
        const rel = file.replace(BUNDLED_SKILLS_DIR + '/', '');
        violations.push(rel);
      }
    }
    expect(
      violations,
      `Bundled skills must not use plaintext credential placeholders ` +
      `like \`<value from credential_store ...>\` — these require reading secrets into conversation context. ` +
      `Use server-side endpoints that resolve credentials from secure storage instead.\n` +
      `Violations:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    ).toEqual([]);
  });

  test('no bundled skills use direct keychain retrieval for credential keys', () => {
    const violations: string[] = [];
    // Match security find-generic-password or secret-tool lookup targeting credential: keys
    const keychainPatterns = [
      /security\s+find-generic-password\s+[^]*?credential:/,
      /secret-tool\s+lookup\s+[^]*?credential:/,
    ];
    for (const file of skillFiles) {
      const content = readFileSync(file, 'utf-8');
      for (const pattern of keychainPatterns) {
        if (pattern.test(content)) {
          const rel = file.replace(BUNDLED_SKILLS_DIR + '/', '');
          if (!violations.includes(rel)) violations.push(rel);
        }
      }
    }
    expect(
      violations,
      `Bundled skills must not use direct keychain/secret-tool commands to read credential keys. ` +
      `Use server-side endpoints that resolve credentials from secure storage instead.\n` +
      `Violations:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    ).toEqual([]);
  });
});
