import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect,test } from 'bun:test';

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

    test('contains emoji auto-selection with change-later instruction', () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain('emoji');
      expect(lower).toContain('change it later');
    });

    test('contains the Home Base handoff format', () => {
      expect(bootstrap).toMatch(/came up with X ideas/i);
      expect(bootstrap).toMatch(/check this out/i);
    });

    test('mentions avatar evolution instruction', () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain('avatar will start to reflect');
      expect(lower).toContain('happens automatically');
    });

    test('contains naming intent markers so the first reply includes naming cues', () => {
      const lower = bootstrap.toLowerCase();
      // The template must prompt the assistant to ask about names.
      // These keywords align with the client-side naming intent heuristic
      // (ChatViewModel.replyContainsNamingIntent) so that the first reply
      // naturally passes the quality check without triggering a corrective nudge.
      expect(lower).toContain('name');
      expect(lower).toContain('call');
      // The example first message should include a naming question
      expect(lower).toContain('what should i call myself');
      // The conversation sequence must include identity/naming as the first step
      expect(lower).toContain('who am i');
      expect(lower).toContain('who are you');
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

    test('contains the style tendency field', () => {
      expect(identity).toContain('**Style tendency:**');
    });
  });
});
