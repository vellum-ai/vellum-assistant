import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

import { ScaffoldManagedSkillTool } from '../tools/skills/scaffold-managed.js';
import type { ToolContext } from '../tools/types.js';

// Use internal class directly to avoid registry side effects
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- bypass private constructor for testing
const tool = new (ScaffoldManagedSkillTool as any)() as InstanceType<typeof ScaffoldManagedSkillTool>;

function makeContext(): ToolContext {
  return {
    workingDir: '/tmp',
    sessionId: 'test-session',
    conversationId: 'test-conversation',
  };
}

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'scaffold-tool-test-'));
  mkdirSync(join(TEST_DIR, 'skills'), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('scaffold_managed_skill tool', () => {
  test('creates a valid skill and index entry', async () => {
    const result = await tool.execute({
      skill_id: 'test-skill',
      name: 'Test Skill',
      description: 'A test skill',
      body_markdown: 'Do the thing.',
    }, makeContext());

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.created).toBe(true);
    expect(parsed.skill_id).toBe('test-skill');
    expect(parsed.index_updated).toBe(true);

    // Verify file was created
    const skillFile = join(TEST_DIR, 'skills', 'test-skill', 'SKILL.md');
    expect(existsSync(skillFile)).toBe(true);
    const content = readFileSync(skillFile, 'utf-8');
    expect(content).toContain('name: "Test Skill"');

    // Verify index was updated
    const indexContent = readFileSync(join(TEST_DIR, 'skills', 'SKILLS.md'), 'utf-8');
    expect(indexContent).toContain('- test-skill');
  });

  test('rejects duplicate unless overwrite=true', async () => {
    await tool.execute({
      skill_id: 'dupe',
      name: 'Original',
      description: 'First',
      body_markdown: 'V1.',
    }, makeContext());

    const result2 = await tool.execute({
      skill_id: 'dupe',
      name: 'Duplicate',
      description: 'Second',
      body_markdown: 'V2.',
    }, makeContext());
    expect(result2.isError).toBe(true);
    expect(result2.content).toContain('already exists');

    const result3 = await tool.execute({
      skill_id: 'dupe',
      name: 'Overwritten',
      description: 'Third',
      body_markdown: 'V3.',
      overwrite: true,
    }, makeContext());
    expect(result3.isError).toBe(false);
  });

  test('rejects missing required fields', async () => {
    const cases = [
      { name: 'N', description: 'D', body_markdown: 'B' }, // missing skill_id
      { skill_id: 's', description: 'D', body_markdown: 'B' }, // missing name
      { skill_id: 's', name: 'N', body_markdown: 'B' }, // missing description
      { skill_id: 's', name: 'N', description: 'D' }, // missing body_markdown
    ];

    for (const input of cases) {
      const result = await tool.execute(input, makeContext());
      expect(result.isError).toBe(true);
    }
  });

  test('rejects invalid skill_id', async () => {
    const result = await tool.execute({
      skill_id: '../escape',
      name: 'Bad',
      description: 'Bad',
      body_markdown: 'Bad.',
    }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('traversal');
  });
});
