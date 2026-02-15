import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

let TEST_DIR = '';

mock.module('../util/platform.js', () => ({
  getRootDir: () => TEST_DIR,
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import {
  validateManagedSkillId,
  getManagedSkillsDir,
  getManagedSkillDir,
  buildSkillMarkdown,
  upsertSkillsIndexEntry,
  removeSkillsIndexEntry,
  createManagedSkill,
  deleteManagedSkill,
} from '../skills/managed-store.js';

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'managed-store-test-'));
  mkdirSync(join(TEST_DIR, 'skills'), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('validateManagedSkillId', () => {
  test('accepts valid slug IDs', () => {
    expect(validateManagedSkillId('my-skill')).toBeNull();
    expect(validateManagedSkillId('skill123')).toBeNull();
    expect(validateManagedSkillId('my.skill')).toBeNull();
    expect(validateManagedSkillId('my_skill')).toBeNull();
  });

  test('rejects empty string', () => {
    expect(validateManagedSkillId('')).not.toBeNull();
  });

  test('rejects traversal patterns', () => {
    expect(validateManagedSkillId('../escape')).not.toBeNull();
    expect(validateManagedSkillId('foo/bar')).not.toBeNull();
    expect(validateManagedSkillId('foo\\bar')).not.toBeNull();
  });

  test('rejects uppercase', () => {
    expect(validateManagedSkillId('MySkill')).not.toBeNull();
  });

  test('rejects IDs starting with special chars', () => {
    expect(validateManagedSkillId('.hidden')).not.toBeNull();
    expect(validateManagedSkillId('-dash')).not.toBeNull();
  });
});

describe('buildSkillMarkdown', () => {
  test('generates valid frontmatter and body', () => {
    const result = buildSkillMarkdown({
      name: 'Test Skill',
      description: 'A test skill',
      bodyMarkdown: 'Do the thing.',
    });
    expect(result).toContain('---\n');
    expect(result).toContain('name: "Test Skill"');
    expect(result).toContain('description: "A test skill"');
    expect(result).toContain('Do the thing.');
    expect(result.endsWith('\n')).toBe(true);
  });

  test('includes optional emoji', () => {
    const result = buildSkillMarkdown({
      name: 'Emoji Skill',
      description: 'Has an emoji',
      bodyMarkdown: 'Body.',
      emoji: '🧪',
    });
    expect(result).toContain('emoji: "🧪"');
  });

  test('includes user-invocable=false when specified', () => {
    const result = buildSkillMarkdown({
      name: 'Internal',
      description: 'Not user invocable',
      bodyMarkdown: 'Body.',
      userInvocable: false,
    });
    expect(result).toContain('user-invocable: false');
  });

  test('includes disable-model-invocation when true', () => {
    const result = buildSkillMarkdown({
      name: 'Manual',
      description: 'Manual only',
      bodyMarkdown: 'Body.',
      disableModelInvocation: true,
    });
    expect(result).toContain('disable-model-invocation: true');
  });
});

describe('SKILLS.md index management', () => {
  test('SKILLS.md is created when absent', () => {
    upsertSkillsIndexEntry('my-skill');
    const indexPath = join(TEST_DIR, 'skills', 'SKILLS.md');
    expect(existsSync(indexPath)).toBe(true);
    const content = readFileSync(indexPath, 'utf-8');
    expect(content).toContain('- my-skill');
  });

  test('index add is idempotent', () => {
    upsertSkillsIndexEntry('my-skill');
    upsertSkillsIndexEntry('my-skill');
    const content = readFileSync(join(TEST_DIR, 'skills', 'SKILLS.md'), 'utf-8');
    const matches = content.match(/- my-skill/g);
    expect(matches?.length).toBe(1);
  });

  test('delete removes directory and index entry', () => {
    // Set up a skill
    const skillDir = join(TEST_DIR, 'skills', 'doomed');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), 'test');
    writeFileSync(
      join(TEST_DIR, 'skills', 'SKILLS.md'),
      '- doomed\n- survivor\n',
    );

    const result = deleteManagedSkill('doomed');
    expect(result.deleted).toBe(true);
    expect(result.indexUpdated).toBe(true);
    expect(existsSync(skillDir)).toBe(false);

    const content = readFileSync(join(TEST_DIR, 'skills', 'SKILLS.md'), 'utf-8');
    expect(content).not.toContain('doomed');
    expect(content).toContain('survivor');
  });

  test('remove from index handles missing entry gracefully', () => {
    writeFileSync(
      join(TEST_DIR, 'skills', 'SKILLS.md'),
      '- other-skill\n',
    );
    removeSkillsIndexEntry('nonexistent');
    const content = readFileSync(join(TEST_DIR, 'skills', 'SKILLS.md'), 'utf-8');
    expect(content).toContain('other-skill');
  });
});

describe('createManagedSkill', () => {
  test('creates skill and writes to expected path', () => {
    const result = createManagedSkill({
      id: 'test-skill',
      name: 'Test Skill',
      description: 'A test skill',
      bodyMarkdown: 'Instructions here.',
    });

    expect(result.created).toBe(true);
    expect(result.error).toBeUndefined();
    expect(existsSync(result.path)).toBe(true);

    const content = readFileSync(result.path, 'utf-8');
    expect(content).toContain('name: "Test Skill"');
    expect(content).toContain('Instructions here.');
  });

  test('rejects duplicate unless overwrite=true', () => {
    createManagedSkill({
      id: 'dupe',
      name: 'Original',
      description: 'First version',
      bodyMarkdown: 'V1.',
    });

    const result2 = createManagedSkill({
      id: 'dupe',
      name: 'Duplicate',
      description: 'Second version',
      bodyMarkdown: 'V2.',
    });
    expect(result2.created).toBe(false);
    expect(result2.error).toContain('already exists');

    const result3 = createManagedSkill({
      id: 'dupe',
      name: 'Overwritten',
      description: 'Third version',
      bodyMarkdown: 'V3.',
      overwrite: true,
    });
    expect(result3.created).toBe(true);
    const content = readFileSync(result3.path, 'utf-8');
    expect(content).toContain('Overwritten');
  });

  test('rejects invalid IDs', () => {
    const result = createManagedSkill({
      id: '../escape',
      name: 'Bad',
      description: 'Bad',
      bodyMarkdown: 'Bad.',
    });
    expect(result.created).toBe(false);
    expect(result.error).toContain('traversal');
  });

  test('updates SKILLS.md index', () => {
    createManagedSkill({
      id: 'indexed-skill',
      name: 'Indexed',
      description: 'Gets indexed',
      bodyMarkdown: 'Body.',
    });

    const indexContent = readFileSync(join(TEST_DIR, 'skills', 'SKILLS.md'), 'utf-8');
    expect(indexContent).toContain('- indexed-skill');
  });

  test('skips index when addToIndex=false', () => {
    createManagedSkill({
      id: 'no-index',
      name: 'No Index',
      description: 'Not indexed',
      bodyMarkdown: 'Body.',
      addToIndex: false,
    });

    const indexPath = join(TEST_DIR, 'skills', 'SKILLS.md');
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, 'utf-8');
      expect(content).not.toContain('no-index');
    }
  });
});

describe('deleteManagedSkill', () => {
  test('deletes existing skill', () => {
    createManagedSkill({
      id: 'to-delete',
      name: 'Delete Me',
      description: 'Will be deleted',
      bodyMarkdown: 'Gone soon.',
    });

    const result = deleteManagedSkill('to-delete');
    expect(result.deleted).toBe(true);
    expect(existsSync(join(TEST_DIR, 'skills', 'to-delete'))).toBe(false);
  });

  test('returns error for non-existent skill', () => {
    const result = deleteManagedSkill('ghost');
    expect(result.deleted).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('rejects invalid IDs', () => {
    const result = deleteManagedSkill('../bad');
    expect(result.deleted).toBe(false);
    expect(result.error).toContain('traversal');
  });

  test('skips index removal when removeFromIndex=false', () => {
    createManagedSkill({
      id: 'keep-index',
      name: 'Keep Index',
      description: 'Index stays',
      bodyMarkdown: 'Body.',
    });

    const result = deleteManagedSkill('keep-index', false);
    expect(result.deleted).toBe(true);
    expect(result.indexUpdated).toBe(false);

    const indexContent = readFileSync(join(TEST_DIR, 'skills', 'SKILLS.md'), 'utf-8');
    expect(indexContent).toContain('- keep-index');
  });
});
