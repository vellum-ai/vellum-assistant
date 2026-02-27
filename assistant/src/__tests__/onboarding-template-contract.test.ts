import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect,test } from 'bun:test';

const templatesDir = join(import.meta.dirname, '..', 'config', 'templates');
const bootstrap = readFileSync(join(templatesDir, 'BOOTSTRAP.md'), 'utf-8');
const identity = readFileSync(join(templatesDir, 'IDENTITY.md'), 'utf-8');
const user = readFileSync(join(templatesDir, 'USER.md'), 'utf-8');

describe('onboarding template contracts', () => {
  describe('BOOTSTRAP.md', () => {
    test('contains identity question prompts', () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain('who am i');
      expect(lower).toContain('who are you');
    });

    test('infers personality indirectly instead of asking directly', () => {
      // Personality should NOT appear as a step label (e.g., "What is my personality?")
      // It can appear in negative instructions ("don't ask what is my personality")
      // and in non-step contexts (avatar evolution sentence).
      expect(bootstrap).not.toMatch(/^\d+\.\s+\*\*.*personality.*\*\*/im);
      // The indirect inference step should exist
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain('vibe');
      expect(lower).toContain('infer');
    });

    test('contains emoji auto-selection with change-later instruction', () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain('emoji');
      expect(lower).toContain('change it later');
    });

    test('creates Home Base silently in the background', () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain('app_create');
      expect(lower).toContain('set_as_home_base');
      // Must NOT open or announce it
      expect(lower).toContain('do not open it with `app_open`');
      expect(lower).toContain('do not announce it');
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

    test('asks user name AFTER assistant identity is established', () => {
      // Step 1 is naming the assistant, step 4 is asking user's name
      const assistantNameIdx = bootstrap.indexOf('What should I call myself?');
      const userNameIdx = bootstrap.indexOf('who am I talking to?');
      expect(assistantNameIdx).toBeGreaterThan(-1);
      expect(userNameIdx).toBeGreaterThan(-1);
      expect(assistantNameIdx).toBeLessThan(userNameIdx);
    });

    test('gathers user context: work role, hobbies, daily tools', () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain('work');
      expect(lower).toContain('hobbies');
      expect(lower).toContain('tools');
    });

    test('shows exactly 2 suggestions via ui_show', () => {
      expect(bootstrap).toContain('ui_show');
      expect(bootstrap).toContain('exactly 2');
      expect(bootstrap).toContain('onboarding_suggestion_1');
      expect(bootstrap).toContain('onboarding_suggestion_2');
    });

    test('contains completion gate with all required conditions', () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain('completion gate');
      expect(lower).toContain('do not delete this file');
      // All conditions must be present
      expect(lower).toContain('you have a name');
      expect(lower).toContain('vibe');
      expect(lower).toContain("user's name");
      expect(lower).toContain('work role');
      expect(lower).toContain('2 suggestions shown');
      expect(lower).toContain('selected one, deferred both');
      expect(lower).toContain('home base');
    });

    test('preserves no em dashes instruction', () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain('em dashes');
    });

    test('preserves no technical jargon instruction', () => {
      const lower = bootstrap.toLowerCase();
      expect(lower).toContain('technical jargon');
      expect(lower).toContain('system internals');
    });

    test('preserves comment line format instruction', () => {
      // The template must start with the comment format explanation
      expect(bootstrap).toMatch(/^_ Lines starting with _/);
    });

    test('instructs saving to IDENTITY.md, USER.md, and SOUL.md via file_edit', () => {
      expect(bootstrap).toContain('IDENTITY.md');
      expect(bootstrap).toContain('USER.md');
      expect(bootstrap).toContain('SOUL.md');
      expect(bootstrap).toContain('file_edit');
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

  describe('USER.md', () => {
    test('contains onboarding snapshot with all required fields', () => {
      expect(user).toContain('Preferred name/reference:');
      expect(user).toContain('Goals:');
      expect(user).toContain('Locale:');
      expect(user).toContain('Work role:');
      expect(user).toContain('Hobbies/fun:');
      expect(user).toContain('Daily tools:');
    });
  });
});
