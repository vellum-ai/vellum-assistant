import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeSkillVersionHash } from '../skills/version-hash.js';

const testDirs: string[] = [];

function makeTempSkill(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-hash-test-'));
  testDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('computeSkillVersionHash', () => {
  test('returns a v1: prefixed sha256 hash', () => {
    const dir = makeTempSkill();
    writeFileSync(join(dir, 'SKILL.md'), '# My Skill\n');
    const hash = computeSkillVersionHash(dir);
    expect(hash).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test('is deterministic for same content', () => {
    const dir = makeTempSkill();
    writeFileSync(join(dir, 'SKILL.md'), '# My Skill\n');
    writeFileSync(join(dir, 'executor.ts'), 'export const run = () => {};');
    const hash1 = computeSkillVersionHash(dir);
    const hash2 = computeSkillVersionHash(dir);
    expect(hash1).toBe(hash2);
  });

  test('changes when file content changes', () => {
    const dir = makeTempSkill();
    writeFileSync(join(dir, 'executor.ts'), 'export const run = () => "v1";');
    const hash1 = computeSkillVersionHash(dir);

    writeFileSync(join(dir, 'executor.ts'), 'export const run = () => "v2";');
    const hash2 = computeSkillVersionHash(dir);

    expect(hash1).not.toBe(hash2);
  });

  test('changes when a new file is added', () => {
    const dir = makeTempSkill();
    writeFileSync(join(dir, 'SKILL.md'), '# Skill\n');
    const hash1 = computeSkillVersionHash(dir);

    writeFileSync(join(dir, 'extra.ts'), 'export {};');
    const hash2 = computeSkillVersionHash(dir);

    expect(hash1).not.toBe(hash2);
  });

  test('is insensitive to file traversal order', () => {
    // Create two directories with the same files in different creation order
    const dir1 = makeTempSkill();
    writeFileSync(join(dir1, 'b.ts'), 'b');
    writeFileSync(join(dir1, 'a.ts'), 'a');

    const dir2 = makeTempSkill();
    writeFileSync(join(dir2, 'a.ts'), 'a');
    writeFileSync(join(dir2, 'b.ts'), 'b');

    expect(computeSkillVersionHash(dir1)).toBe(computeSkillVersionHash(dir2));
  });

  test('excludes .vellum-skill-run directory', () => {
    const dir = makeTempSkill();
    writeFileSync(join(dir, 'SKILL.md'), '# Skill\n');
    const hash1 = computeSkillVersionHash(dir);

    mkdirSync(join(dir, '.vellum-skill-run'), { recursive: true });
    writeFileSync(join(dir, '.vellum-skill-run', 'state.json'), '{}');
    const hash2 = computeSkillVersionHash(dir);

    expect(hash1).toBe(hash2);
  });

  test('excludes node_modules directory', () => {
    const dir = makeTempSkill();
    writeFileSync(join(dir, 'SKILL.md'), '# Skill\n');
    const hash1 = computeSkillVersionHash(dir);

    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = {};');
    const hash2 = computeSkillVersionHash(dir);

    expect(hash1).toBe(hash2);
  });

  test('includes subdirectory files', () => {
    const dir = makeTempSkill();
    writeFileSync(join(dir, 'SKILL.md'), '# Skill\n');
    const hash1 = computeSkillVersionHash(dir);

    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(join(dir, 'tools', 'helper.ts'), 'export {};');
    const hash2 = computeSkillVersionHash(dir);

    expect(hash1).not.toBe(hash2);
  });

  test('empty directory produces a consistent hash', () => {
    const dir = makeTempSkill();
    const hash = computeSkillVersionHash(dir);
    expect(hash).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test('skips symlinked directories to avoid loops', () => {
    const dir = makeTempSkill();
    writeFileSync(join(dir, 'SKILL.md'), '# Skill\n');
    const hash1 = computeSkillVersionHash(dir);

    // Create a symlink that points back to the skill dir (would loop with statSync)
    symlinkSync(dir, join(dir, 'loop'));
    const hash2 = computeSkillVersionHash(dir);

    expect(hash1).toBe(hash2);
  });

  test('skips symlinked files', () => {
    const dir = makeTempSkill();
    writeFileSync(join(dir, 'real.ts'), 'export {};');
    const hash1 = computeSkillVersionHash(dir);

    // Add a symlink to an existing file — should be ignored
    symlinkSync(join(dir, 'real.ts'), join(dir, 'linked.ts'));
    const hash2 = computeSkillVersionHash(dir);

    expect(hash1).toBe(hash2);
  });
});
