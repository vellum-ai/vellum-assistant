import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const templatesDir = join(import.meta.dirname, '..', 'config', 'templates');
const bootstrap = readFileSync(join(templatesDir, 'BOOTSTRAP.md'), 'utf-8');
const identity = readFileSync(join(templatesDir, 'IDENTITY.md'), 'utf-8');

describe('onboarding template contracts', () => {
  describe('BOOTSTRAP.md', () => {
    test('contains identity question prompts', () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain('who am i');
      expect(lower).toContain('who are you');
    });

    test('uses "personality" for the personality step', () => {
      expect(bootstrap).toContain('What is my personality?');
      // Should not use "character" or "vibe" as a field/step label
      expect(bootstrap).not.toMatch(/what is my (character|vibe)/i);
    });

    test('contains emoji self-selection with change-anytime instruction', () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain('emoji');
      expect(lower).toContain('you can change it');
    });

    test('contains the Home Base handoff format', () => {
      expect(bootstrap).toMatch(/came up with X ideas/i);
      expect(bootstrap).toMatch(/check this out/i);
    });
  });

  describe('IDENTITY.md', () => {
    test('contains canonical fields: Name, Nature, Personality, Emoji', () => {
      expect(identity).toContain('**Name:**');
      expect(identity).toContain('**Nature:**');
      expect(identity).toContain('**Personality:**');
      expect(identity).toContain('**Emoji:**');
    });

    test('contains the emoji overwrite instruction', () => {
      const lower = identity.toLowerCase();
      expect(lower).toContain('change their emoji');
    });
  });
});
