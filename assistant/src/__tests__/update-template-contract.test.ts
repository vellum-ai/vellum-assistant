/**
 * Contract test: ensures the bundled UPDATES.md template exists and meets
 * the format expectations that the bulletin system depends on at runtime.
 *
 * The "## What's New" heading is a structural contract — bulletin rendering
 * logic expects this section to be present in the template.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const TEMPLATE_PATH = join(import.meta.dirname, '..', 'config', 'templates', 'UPDATES.md');

describe('UPDATES.md template contract', () => {
  test('template file exists', () => {
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
  });

  test('template contains non-whitespace content', () => {
    const content = readFileSync(TEMPLATE_PATH, 'utf-8');
    expect(content.trim().length).toBeGreaterThan(0);
  });

  test('template contains the "## What\'s New" heading', () => {
    const content = readFileSync(TEMPLATE_PATH, 'utf-8');
    expect(content).toContain("## What's New");
  });
});
