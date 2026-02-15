import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

let TEST_DIR = '';

mock.module('../util/platform.js', () => ({
  getRootDir: () => TEST_DIR,
  getDataDir: () => TEST_DIR,
  ensureDataDir: () => {},
  getSocketPath: () => join(TEST_DIR, 'vellum.sock'),
  getPidPath: () => join(TEST_DIR, 'vellum.pid'),
  getDbPath: () => join(TEST_DIR, 'data', 'assistant.db'),
  getLogPath: () => join(TEST_DIR, 'logs', 'vellum.log'),
  getHistoryPath: () => join(TEST_DIR, 'history'),
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getPlatformName: () => process.platform,
  getClipboardCommand: () => null,
  removeSocketFile: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import { ScaffoldManagedSkillTool } from '../tools/skills/scaffold-managed.js';
import { DeleteManagedSkillTool } from '../tools/skills/delete-managed.js';
import { loadSkillCatalog } from '../config/skills.js';
import { buildSystemPrompt } from '../config/system-prompt.js';
import type { ToolContext } from '../tools/types.js';

const scaffoldTool = new (ScaffoldManagedSkillTool as any)() as InstanceType<typeof ScaffoldManagedSkillTool>;
const deleteTool = new (DeleteManagedSkillTool as any)() as InstanceType<typeof DeleteManagedSkillTool>;

function makeContext(): ToolContext {
  return {
    workingDir: '/tmp',
    sessionId: 'test-session',
    conversationId: 'test-conversation',
  };
}

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
  mkdirSync(join(TEST_DIR, 'skills'), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('managed skill lifecycle: scaffold → catalog → prompt → delete', () => {
  test('full lifecycle: create skill, verify in catalog and prompt, then delete', async () => {
    // Step 1: Scaffold a managed skill
    const scaffoldResult = await scaffoldTool.execute({
      skill_id: 'lifecycle-test',
      name: 'Lifecycle Test',
      description: 'Integration test skill.',
      body_markdown: 'Run the lifecycle test procedure.',
      emoji: '🧪',
    }, makeContext());

    expect(scaffoldResult.isError).not.toBe(true);
    const scaffoldData = JSON.parse(scaffoldResult.content as string);
    expect(scaffoldData.created).toBe(true);

    // Step 2: Verify SKILL.md was written
    const skillMdPath = join(TEST_DIR, 'skills', 'lifecycle-test', 'SKILL.md');
    expect(existsSync(skillMdPath)).toBe(true);
    const skillContent = readFileSync(skillMdPath, 'utf-8');
    expect(skillContent).toContain('name: "Lifecycle Test"');
    expect(skillContent).toContain('description: "Integration test skill."');
    expect(skillContent).toContain('Run the lifecycle test procedure.');

    // Step 3: Verify skill appears in catalog
    const catalog = loadSkillCatalog();
    const found = catalog.find(s => s.id === 'lifecycle-test');
    expect(found).toBeDefined();
    expect(found!.name).toBe('Lifecycle Test');
    expect(found!.description).toBe('Integration test skill.');

    // Step 4: Verify skill appears in system prompt
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('lifecycle-test');
    expect(prompt).toContain('Lifecycle Test');
    expect(prompt).toContain('## Dynamic Skill Authoring Workflow');

    // Step 5: Delete the skill
    const deleteResult = await deleteTool.execute({
      skill_id: 'lifecycle-test',
    }, makeContext());

    expect(deleteResult.isError).not.toBe(true);
    const deleteData = JSON.parse(deleteResult.content as string);
    expect(deleteData.deleted).toBe(true);

    // Step 6: Verify skill is gone from filesystem
    expect(existsSync(skillMdPath)).toBe(false);

    // Step 7: Verify skill no longer in catalog
    const catalogAfter = loadSkillCatalog();
    expect(catalogAfter.find(s => s.id === 'lifecycle-test')).toBeUndefined();

    // Step 8: Verify SKILLS.md index no longer has the entry
    const indexPath = join(TEST_DIR, 'skills', 'SKILLS.md');
    if (existsSync(indexPath)) {
      const indexContent = readFileSync(indexPath, 'utf-8');
      expect(indexContent).not.toContain('lifecycle-test');
    }
  });

  test('scaffold with overwrite replaces existing skill', async () => {
    const ctx = makeContext();

    // Create initial skill
    await scaffoldTool.execute({
      skill_id: 'overwrite-test',
      name: 'V1',
      description: 'Version 1.',
      body_markdown: 'Original body.',
    }, ctx);

    // Overwrite with updated content
    const result = await scaffoldTool.execute({
      skill_id: 'overwrite-test',
      name: 'V2',
      description: 'Version 2.',
      body_markdown: 'Updated body.',
      overwrite: true,
    }, ctx);

    expect(result.isError).not.toBe(true);

    const skillContent = readFileSync(
      join(TEST_DIR, 'skills', 'overwrite-test', 'SKILL.md'), 'utf-8'
    );
    expect(skillContent).toContain('name: "V2"');
    expect(skillContent).toContain('Updated body.');
    expect(skillContent).not.toContain('Original body.');

    // Index should still have exactly one entry
    const indexContent = readFileSync(
      join(TEST_DIR, 'skills', 'SKILLS.md'), 'utf-8'
    );
    const matches = indexContent.match(/overwrite-test/g);
    expect(matches?.length).toBe(1);
  });

  test('delete non-existent skill returns error', async () => {
    const result = await deleteTool.execute({
      skill_id: 'does-not-exist',
    }, makeContext());

    expect(result.isError).toBe(true);
  });
});
