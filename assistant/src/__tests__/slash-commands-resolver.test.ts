import { describe, expect, test } from 'bun:test';
import {
  buildInvocableSlashCatalog,
  formatUnknownSlashSkillMessage,
  resolveSlashSkillCommand,
  type InvocableSlashSkill,
} from '../skills/slash-commands.js';
import type { SkillSummary } from '../config/skills.js';
import type { ResolvedSkill } from '../config/skill-state.js';

function makeSkill(id: string, overrides?: Partial<SkillSummary>): SkillSummary {
  return {
    id,
    name: overrides?.name ?? id,
    description: `Description for ${id}`,
    directoryPath: `/skills/${id}`,
    skillFilePath: `/skills/${id}/SKILL.md`,
    userInvocable: overrides?.userInvocable ?? true,
    disableModelInvocation: false,
    source: 'managed',
  };
}

function makeResolved(skill: SkillSummary, state: ResolvedSkill['state']): ResolvedSkill {
  return {
    summary: skill,
    state,
    degraded: state === 'degraded',
  };
}

function buildCatalog(skills: SkillSummary[]): Map<string, InvocableSlashSkill> {
  const resolved = skills.map((s) => makeResolved(s, 'enabled'));
  return buildInvocableSlashCatalog(skills, resolved);
}

describe('resolveSlashSkillCommand', () => {
  test('returns none for normal text', () => {
    const catalog = buildCatalog([makeSkill('start-the-day')]);
    expect(resolveSlashSkillCommand('hello world', catalog)).toEqual({ kind: 'none' });
  });

  test('returns none for empty input', () => {
    const catalog = buildCatalog([]);
    expect(resolveSlashSkillCommand('', catalog)).toEqual({ kind: 'none' });
  });

  test('returns none for path-like /tmp/file', () => {
    const catalog = buildCatalog([makeSkill('tmp')]);
    expect(resolveSlashSkillCommand('/tmp/file', catalog)).toEqual({ kind: 'none' });
  });

  test('returns known for exact ID match', () => {
    const catalog = buildCatalog([makeSkill('start-the-day')]);
    const result = resolveSlashSkillCommand('/start-the-day', catalog);
    expect(result).toEqual({ kind: 'known', skillId: 'start-the-day', trailingArgs: '' });
  });

  test('returns known with trailing args', () => {
    const catalog = buildCatalog([makeSkill('start-the-day')]);
    const result = resolveSlashSkillCommand('/start-the-day weather in SF', catalog);
    expect(result).toEqual({
      kind: 'known',
      skillId: 'start-the-day',
      trailingArgs: 'weather in SF',
    });
  });

  test('known match is case-insensitive but returns canonical ID', () => {
    const catalog = buildCatalog([makeSkill('Start-The-Day')]);
    const result = resolveSlashSkillCommand('/start-the-day', catalog);
    expect(result.kind).toBe('known');
    if (result.kind === 'known') {
      expect(result.skillId).toBe('Start-The-Day');
    }
  });

  test('returns unknown for unrecognized slash command', () => {
    const catalog = buildCatalog([makeSkill('start-the-day')]);
    const result = resolveSlashSkillCommand('/not-a-skill', catalog);
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      expect(result.requestedId).toBe('not-a-skill');
      expect(result.message).toContain('Unknown command `/not-a-skill`');
      expect(result.message).toContain('`/start-the-day`');
    }
  });

  test('unknown message lists available skills sorted', () => {
    const catalog = buildCatalog([makeSkill('zebra'), makeSkill('alpha'), makeSkill('mid')]);
    const result = resolveSlashSkillCommand('/nope', catalog);
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      const lines = result.message.split('\n');
      const skillLines = lines.filter((l) => l.startsWith('- `'));
      expect(skillLines[0]).toContain('/alpha');
      expect(skillLines[1]).toContain('/mid');
      expect(skillLines[2]).toContain('/zebra');
    }
  });

  test('handles leading whitespace in input', () => {
    const catalog = buildCatalog([makeSkill('start-the-day')]);
    const result = resolveSlashSkillCommand('   /start-the-day   foo bar', catalog);
    expect(result).toEqual({
      kind: 'known',
      skillId: 'start-the-day',
      trailingArgs: 'foo bar',
    });
  });
});

describe('formatUnknownSlashSkillMessage', () => {
  test('includes requested ID and available skills', () => {
    const msg = formatUnknownSlashSkillMessage('bad-cmd', ['alpha', 'beta']);
    expect(msg).toContain('Unknown command `/bad-cmd`');
    expect(msg).toContain('- `/alpha`');
    expect(msg).toContain('- `/beta`');
  });

  test('shows no-commands message when catalog is empty', () => {
    const msg = formatUnknownSlashSkillMessage('bad-cmd', []);
    expect(msg).toContain('Unknown command `/bad-cmd`');
    expect(msg).toContain('No slash commands are currently available.');
  });
});
