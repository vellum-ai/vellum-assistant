import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `vellum-skills-test-${crypto.randomUUID()}`);

mock.module('../util/platform.js', () => ({
  getRootDir: () => TEST_DIR,
  getDataDir: () => TEST_DIR,
  ensureDataDir: () => {},
  getSocketPath: () => join(TEST_DIR, 'vellum.sock'),
  getPidPath: () => join(TEST_DIR, 'vellum.pid'),
  getDbPath: () => join(TEST_DIR, 'data', 'assistant.db'),
  getLogPath: () => join(TEST_DIR, 'logs', 'vellum.log'),
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getPlatformName: () => process.platform,
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

const { loadSkillCatalog } = await import('../config/skills.js');

/** Return only user-installed skills (filters out bundled skills that ship with the source tree). */
function loadUserSkillCatalog() {
  return loadSkillCatalog().filter((s) => !s.bundled);
}

function writeSkill(skillId: string, name: string, description: string, body: string = 'Skill body'): void {
  const skillDir = join(TEST_DIR, 'skills', skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: "${name}"\ndescription: "${description}"\n---\n\n${body}\n`,
  );
}

describe('skills catalog loading', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, 'skills'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test('parses markdown list path entries from SKILLS.md', () => {
    writeSkill('alpha', 'Alpha Skill', 'First skill');
    writeSkill('beta', 'Beta Skill', 'Second skill');
    writeFileSync(
      join(TEST_DIR, 'skills', 'SKILLS.md'),
      '- alpha\n- beta/SKILL.md\n',
    );

    const catalog = loadUserSkillCatalog();
    expect(catalog.map((skill) => skill.id)).toEqual(['alpha', 'beta']);
  });

  test('resolves markdown links from SKILLS.md', () => {
    writeSkill('lint', 'Lint Skill', 'Runs lint checks');
    writeSkill('test', 'Test Skill', 'Runs test checks');
    writeFileSync(
      join(TEST_DIR, 'skills', 'SKILLS.md'),
      '- [Lint](lint)\n- [Tests](test)\n',
    );

    const catalog = loadUserSkillCatalog();
    expect(catalog.map((skill) => skill.id)).toEqual(['lint', 'test']);
  });

  test('rejects SKILLS.md entries that resolve outside ~/.vellum/skills', () => {
    writeSkill('safe', 'Safe Skill', 'Safe skill');
    writeFileSync(
      join(TEST_DIR, 'skills', 'SKILLS.md'),
      '- ../escape\n- /tmp/absolute\n- safe\n',
    );

    const catalog = loadUserSkillCatalog();
    expect(catalog.map((skill) => skill.id)).toEqual(['safe']);
  });

  test('rejects symlinked SKILLS.md entries that point outside ~/.vellum/skills', () => {
    const externalSkillDir = join(TEST_DIR, 'outside', 'external-skill');
    mkdirSync(externalSkillDir, { recursive: true });
    writeFileSync(
      join(externalSkillDir, 'SKILL.md'),
      '---\nname: "External Skill"\ndescription: "Outside skills root."\n---\n\nDo not load.\n',
    );

    symlinkSync(externalSkillDir, join(TEST_DIR, 'skills', 'linked-skill'));
    writeFileSync(join(TEST_DIR, 'skills', 'SKILLS.md'), '- linked-skill\n');

    const catalog = loadUserSkillCatalog();
    expect(catalog).toHaveLength(0);
  });

  test('rejects symlinked SKILL.md files that point outside ~/.vellum/skills', () => {
    const linkedSkillDir = join(TEST_DIR, 'skills', 'linked-file-skill');
    mkdirSync(linkedSkillDir, { recursive: true });

    const outsideDir = join(TEST_DIR, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const externalSkillFile = join(outsideDir, 'external-skill.md');
    writeFileSync(
      externalSkillFile,
      '---\nname: "External File Skill"\ndescription: "Outside skills root."\n---\n\nDo not load.\n',
    );

    symlinkSync(externalSkillFile, join(linkedSkillDir, 'SKILL.md'));
    writeFileSync(join(TEST_DIR, 'skills', 'SKILLS.md'), '- linked-file-skill\n');

    const catalog = loadUserSkillCatalog();
    expect(catalog).toHaveLength(0);
  });

  test('uses SKILLS.md ordering when index exists', () => {
    writeSkill('first', 'First Skill', 'First');
    writeSkill('second', 'Second Skill', 'Second');
    writeFileSync(
      join(TEST_DIR, 'skills', 'SKILLS.md'),
      '- second\n- first\n',
    );

    const catalog = loadUserSkillCatalog();
    expect(catalog.map((skill) => skill.id)).toEqual(['second', 'first']);
  });

  test('falls back to auto-discovery when SKILLS.md is missing', () => {
    writeSkill('zeta', 'Zeta Skill', 'Zeta');
    writeSkill('alpha', 'Alpha Skill', 'Alpha');

    const catalog = loadUserSkillCatalog();
    expect(catalog.map((skill) => skill.id)).toEqual(['alpha', 'zeta']);
  });

  test('treats SKILLS.md as authoritative when present', () => {
    writeSkill('available', 'Available Skill', 'Present on disk');
    writeFileSync(
      join(TEST_DIR, 'skills', 'SKILLS.md'),
      '- ../invalid-only\n',
    );

    const catalog = loadUserSkillCatalog();
    expect(catalog).toHaveLength(0);
  });
});
