import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `vellum-skill-load-tool-test-${crypto.randomUUID()}`);

mock.module('../util/platform.js', () => ({
  getDataDir: () => TEST_DIR,
  ensureDataDir: () => {},
  getSocketPath: () => join(TEST_DIR, 'vellum.sock'),
  getPidPath: () => join(TEST_DIR, 'vellum.pid'),
  getDbPath: () => join(TEST_DIR, 'data', 'assistant.db'),
  getLogPath: () => join(TEST_DIR, 'logs', 'vellum.log'),
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

await import('../tools/skills/load.js');
const { getTool } = await import('../tools/registry.js');

function writeSkill(skillId: string, name: string, description: string, body: string): void {
  const skillDir = join(TEST_DIR, 'skills', skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: "${name}"\ndescription: "${description}"\n---\n\n${body}\n`,
  );
}

async function executeSkillLoad(input: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  const tool = getTool('skill_load');
  if (!tool) throw new Error('skill_load tool was not registered');

  const result = await tool.execute(input, {
    workingDir: '/tmp',
    sessionId: 'session-1',
    conversationId: 'conversation-1',
  });
  return { content: result.content, isError: result.isError };
}

describe('skill_load tool', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, 'skills'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test('loads a skill by exact id', async () => {
    writeSkill('release-checklist', 'Release Checklist', 'Runs release checks', '1. Run tests');
    writeFileSync(join(TEST_DIR, 'skills', 'SKILLS.md'), '- release-checklist\n');

    const result = await executeSkillLoad({ skill: 'release-checklist' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Skill: Release Checklist');
    expect(result.content).toContain('ID: release-checklist');
    expect(result.content).toContain('1. Run tests');
    expect(result.content).not.toContain('name: "Release Checklist"');
  });

  test('loads a skill by exact name (case-insensitive)', async () => {
    writeSkill('oncall', 'Oncall Runbook', 'Handles incidents', 'Page primary responder');
    writeFileSync(join(TEST_DIR, 'skills', 'SKILLS.md'), '- oncall\n');

    const result = await executeSkillLoad({ skill: 'oncall runbook' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Skill: Oncall Runbook');
    expect(result.content).toContain('Page primary responder');
  });

  test('loads a skill by unique id prefix', async () => {
    writeSkill('incident-response', 'Incident Response', 'Triage incidents', 'Run triage checklist');
    writeSkill('release-checklist', 'Release Checklist', 'Release flow', 'Run release checklist');
    writeFileSync(join(TEST_DIR, 'skills', 'SKILLS.md'), '- incident-response\n- release-checklist\n');

    const result = await executeSkillLoad({ skill: 'incident' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('ID: incident-response');
  });

  test('returns an error when name resolution is ambiguous', async () => {
    writeSkill('skill-a', 'Shared Name', 'First', 'Body A');
    writeSkill('skill-b', 'Shared Name', 'Second', 'Body B');
    writeFileSync(join(TEST_DIR, 'skills', 'SKILLS.md'), '- skill-a\n- skill-b\n');

    const result = await executeSkillLoad({ skill: 'Shared Name' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Ambiguous skill name');
  });

  test('returns an error when skill is missing', async () => {
    writeSkill('existing', 'Existing Skill', 'Exists', 'Body');
    writeFileSync(join(TEST_DIR, 'skills', 'SKILLS.md'), '- existing\n');

    const result = await executeSkillLoad({ skill: 'does-not-exist' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No skill matched');
  });
});
