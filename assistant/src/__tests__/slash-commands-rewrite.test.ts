import { describe, expect, test } from 'bun:test';
import { rewriteKnownSlashCommandPrompt } from '../skills/slash-commands.js';

describe('rewriteKnownSlashCommandPrompt', () => {
  test('produces prompt without trailing args', () => {
    const result = rewriteKnownSlashCommandPrompt({
      rawInput: '/start-the-day',
      skillId: 'start-the-day',
      skillName: 'Start the Day',
      trailingArgs: '',
    });
    expect(result).toContain('`/start-the-day`');
    expect(result).toContain('"Start the Day" skill');
    expect(result).toContain('ID: start-the-day');
    expect(result).not.toContain('User arguments');
  });

  test('includes trailing args verbatim', () => {
    const result = rewriteKnownSlashCommandPrompt({
      rawInput: '/start-the-day weather in SF',
      skillId: 'start-the-day',
      skillName: 'Start the Day',
      trailingArgs: 'weather in SF',
    });
    expect(result).toContain('`/start-the-day`');
    expect(result).toContain('User arguments: weather in SF');
  });

  test('preserves args payload exactly (no trimming of internal whitespace)', () => {
    const args = '  multiple   spaces  here  ';
    const result = rewriteKnownSlashCommandPrompt({
      rawInput: `/my-skill ${args}`,
      skillId: 'my-skill',
      skillName: 'My Skill',
      trailingArgs: args,
    });
    expect(result).toContain(`User arguments: ${args}`);
  });
});
