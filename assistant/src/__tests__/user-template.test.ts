import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mock } from 'bun:test';

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

const { stripCommentLines } = await import('../config/system-prompt.js');

const TEMPLATE_PATH = join(import.meta.dirname ?? __dirname, '..', 'config', 'templates', 'USER.md');
const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
const rendered = stripCommentLines(raw);

describe('USER.md template shape', () => {
  test('contains the top-level USER heading', () => {
    expect(rendered).toContain('# USER');
  });

  test('contains basic profile fields', () => {
    expect(rendered).toContain('**Name:**');
    expect(rendered).toContain('**Pronouns:**');
    expect(rendered).toContain('**What to call you:**');
  });

  test('contains Context section', () => {
    expect(rendered).toContain('## Context');
  });

  describe('Locale section', () => {
    test('has a Locale heading', () => {
      expect(rendered).toContain('## Locale');
    });

    test('contains all locale fields', () => {
      for (const field of ['city', 'region', 'country', 'timezone', 'localeId', 'confidence']) {
        expect(rendered).toContain(`**${field}:**`);
      }
    });

    test('defaults confidence to low', () => {
      expect(rendered).toContain('**confidence:** low');
    });
  });

  describe('Dashboard Color Preference section', () => {
    test('has a Dashboard Color Preference heading', () => {
      expect(rendered).toContain('## Dashboard Color Preference');
    });

    test('contains all color preference fields', () => {
      for (const field of ['label', 'hex', 'source', 'applied']) {
        expect(rendered).toContain(`**${field}:**`);
      }
    });

    test('defaults applied to false', () => {
      expect(rendered).toContain('**applied:** false');
    });
  });

  describe('Onboarding Tasks section', () => {
    test('has an Onboarding Tasks heading', () => {
      expect(rendered).toContain('## Onboarding Tasks');
    });

    test('contains all onboarding task entries', () => {
      for (const task of ['set_name', 'set_locale', 'choose_color', 'first_conversation']) {
        expect(rendered).toContain(`**${task}:**`);
      }
    });

    test('all tasks default to pending', () => {
      for (const task of ['set_name', 'set_locale', 'choose_color', 'first_conversation']) {
        expect(rendered).toContain(`**${task}:** pending`);
      }
    });
  });

  describe('Trust Stage section', () => {
    test('has a Trust Stage heading', () => {
      expect(rendered).toContain('## Trust Stage');
    });

    test('contains all trust stage fields', () => {
      for (const field of ['hatched', 'firstConversationComplete', 'permissionsUnlocked']) {
        expect(rendered).toContain(`**${field}:**`);
      }
    });

    test('all trust stages default to false', () => {
      for (const field of ['hatched', 'firstConversationComplete', 'permissionsUnlocked']) {
        expect(rendered).toContain(`**${field}:** false`);
      }
    });
  });

  describe('comment stripping', () => {
    test('raw template contains comment lines', () => {
      expect(raw).toContain('_ Lines starting with _');
    });

    test('rendered template does not contain comment lines', () => {
      const lines = rendered.split('\n');
      for (const line of lines) {
        expect(line.trimStart().startsWith('_')).toBe(false);
      }
    });
  });

  describe('section ordering', () => {
    test('sections appear in the correct order', () => {
      const sections = ['# USER', '## Context', '## Locale', '## Dashboard Color Preference', '## Onboarding Tasks', '## Trust Stage'];
      let lastIdx = -1;
      for (const section of sections) {
        const idx = rendered.indexOf(section);
        expect(idx).toBeGreaterThan(lastIdx);
        lastIdx = idx;
      }
    });
  });

  describe('client-agnostic', () => {
    test('template does not contain platform-specific references', () => {
      expect(rendered).not.toContain('macOS');
      expect(rendered).not.toContain('darwin');
      expect(rendered).not.toContain('Windows');
      expect(rendered).not.toContain('Linux');
      expect(rendered).not.toContain('iOS');
      expect(rendered).not.toContain('Android');
    });
  });
});
