import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mock, spyOn } from 'bun:test';

let TEST_DIR = '';

mock.module('../util/platform.js', () => ({
  getRootDir: () => TEST_DIR,
  getWorkspaceSkillsDir: () => join(TEST_DIR, 'skills'),
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import { skillsshInstall } from '../skills/skillssh-install.js';
import type { SkillsShInstallOptions, SkillsShProvenance } from '../skills/skillssh-install.js';
import type { SecurityDecision } from '../skills/security-decision.js';
import type { SkillsShSearchWithAuditItem } from '../skills/skillssh.js';
import { readSkillProvenance } from '../skills/managed-store.js';

// ─── Test helpers ────────────────────────────────────────────────────────────────

function makeCandidate(overrides?: Partial<SkillsShSearchWithAuditItem>): SkillsShSearchWithAuditItem {
  return {
    id: 'test-org/test-repo/my-skill',
    skillId: 'my-skill',
    name: 'My Skill',
    installs: 42,
    source: 'test-org/test-repo',
    audit: {
      ath: { risk: 'safe', analyzedAt: '2025-01-01T00:00:00Z' },
      socket: { risk: 'low', analyzedAt: '2025-01-02T00:00:00Z', score: 90 },
    },
    overallRisk: 'low',
    ...overrides,
  };
}

function makeProceedDecision(): SecurityDecision {
  return {
    recommendation: 'proceed',
    overallRisk: 'low',
    rationale: 'All security audits passed with safe/low risk ratings.',
    auditSummary: [
      { provider: 'ath', risk: 'safe', analyzedAt: '2025-01-01T00:00:00Z' },
      { provider: 'socket', risk: 'low', analyzedAt: '2025-01-02T00:00:00Z', details: 'score 90/100' },
    ],
  };
}

function makeCautionDecision(): SecurityDecision {
  return {
    recommendation: 'proceed_with_caution',
    overallRisk: 'medium',
    rationale: 'Medium risk detected.',
    auditSummary: [
      { provider: 'socket', risk: 'medium', analyzedAt: '2025-01-02T00:00:00Z' },
    ],
  };
}

function makeDoNotRecommendDecision(): SecurityDecision {
  return {
    recommendation: 'do_not_recommend',
    overallRisk: 'high',
    rationale: 'High risk detected by Snyk. Review the audit details before proceeding.',
    auditSummary: [
      { provider: 'snyk', risk: 'high', analyzedAt: '2025-01-03T00:00:00Z' },
    ],
  };
}

/**
 * Simulate a successful `npx skills add` by creating the expected
 * skill directory and SKILL.md file in the managed skills dir.
 */
function simulateSuccessfulInstall(skillId: string): void {
  const skillDir = join(TEST_DIR, 'skills', skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: "${skillId}"\ndescription: "A test skill"\n---\n\n# ${skillId}\n`, 'utf-8');
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'skillssh-install-test-'));
  mkdirSync(join(TEST_DIR, 'skills'), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  // Restore all spies
  mock.restore();
});

// ─── Security gate tests ─────────────────────────────────────────────────────────

describe('skillsshInstall security gate', () => {
  test('blocks install when decision is do_not_recommend and no override', async () => {
    const result = await skillsshInstall({
      candidate: makeCandidate({ overallRisk: 'high' }),
      securityDecision: makeDoNotRecommendDecision(),
      userOverride: false,
    });

    expect(result.success).toBe(false);
    expect(result.skillId).toBe('my-skill');
    expect(result.installedVia).toBe('policy');
    expect(result.error).toContain('Installation blocked');
    expect(result.error).toContain('do_not_recommend');
    expect(result.error).toContain('high risk');
  });

  test('blocks install when decision is do_not_recommend and override is undefined', async () => {
    const result = await skillsshInstall({
      candidate: makeCandidate({ overallRisk: 'high' }),
      securityDecision: makeDoNotRecommendDecision(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Installation blocked');
  });

  test('allows install when decision is do_not_recommend but override is true', async () => {
    // Mock Bun.spawn to simulate a successful subprocess
    const originalSpawn = Bun.spawn;
    const mockSpawn = spyOn(Bun, 'spawn').mockImplementation((..._args: unknown[]) => {
      const candidate = makeCandidate({ overallRisk: 'high' });
      simulateSuccessfulInstall(candidate.skillId);

      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Skill installed successfully'));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) { controller.close(); },
        }),
        exited: Promise.resolve(0),
        pid: 12345,
        kill: () => {},
      } as unknown as ReturnType<typeof originalSpawn>;
    });

    try {
      const result = await skillsshInstall({
        candidate: makeCandidate({ overallRisk: 'high' }),
        securityDecision: makeDoNotRecommendDecision(),
        userOverride: true,
      });

      expect(result.success).toBe(true);
      expect(result.installedVia).toBe('override');
      expect(result.skillId).toBe('my-skill');
      expect(result.installedPath).toBeDefined();
    } finally {
      mockSpawn.mockRestore();
    }
  });

  test('allows install when decision is proceed', async () => {
    const originalSpawn = Bun.spawn;
    const mockSpawn = spyOn(Bun, 'spawn').mockImplementation((..._args: unknown[]) => {
      simulateSuccessfulInstall('my-skill');

      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Skill installed successfully'));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) { controller.close(); },
        }),
        exited: Promise.resolve(0),
        pid: 12345,
        kill: () => {},
      } as unknown as ReturnType<typeof originalSpawn>;
    });

    try {
      const result = await skillsshInstall({
        candidate: makeCandidate(),
        securityDecision: makeProceedDecision(),
      });

      expect(result.success).toBe(true);
      expect(result.installedVia).toBe('policy');
      expect(result.skillId).toBe('my-skill');
    } finally {
      mockSpawn.mockRestore();
    }
  });

  test('allows install when decision is proceed_with_caution', async () => {
    const originalSpawn = Bun.spawn;
    const mockSpawn = spyOn(Bun, 'spawn').mockImplementation((..._args: unknown[]) => {
      simulateSuccessfulInstall('my-skill');

      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Skill installed successfully'));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) { controller.close(); },
        }),
        exited: Promise.resolve(0),
        pid: 12345,
        kill: () => {},
      } as unknown as ReturnType<typeof originalSpawn>;
    });

    try {
      const result = await skillsshInstall({
        candidate: makeCandidate({ overallRisk: 'medium' }),
        securityDecision: makeCautionDecision(),
      });

      expect(result.success).toBe(true);
      expect(result.installedVia).toBe('policy');
    } finally {
      mockSpawn.mockRestore();
    }
  });
});

// ─── Provenance metadata tests ───────────────────────────────────────────────────

describe('skillsshInstall provenance', () => {
  test('stores provenance metadata on successful install', async () => {
    const originalSpawn = Bun.spawn;
    const mockSpawn = spyOn(Bun, 'spawn').mockImplementation((..._args: unknown[]) => {
      simulateSuccessfulInstall('my-skill');

      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('OK'));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) { controller.close(); },
        }),
        exited: Promise.resolve(0),
        pid: 12345,
        kill: () => {},
      } as unknown as ReturnType<typeof originalSpawn>;
    });

    try {
      const candidate = makeCandidate();
      const result = await skillsshInstall({
        candidate,
        securityDecision: makeProceedDecision(),
      });

      expect(result.success).toBe(true);
      expect(result.provenance).toBeDefined();
      expect(result.provenance!.provider).toBe('skills.sh');
      expect(result.provenance!.source).toBe('test-org/test-repo');
      expect(result.provenance!.skillId).toBe('my-skill');
      expect(result.provenance!.sourceUrl).toBe('https://skills.sh/skills/test-org/test-repo/my-skill');
      expect(result.provenance!.auditSnapshot.overallRisk).toBe('low');
      expect(result.provenance!.auditSnapshot.dimensions).toHaveLength(2);
      expect(result.provenance!.auditSnapshot.dimensions[0]).toEqual({
        provider: 'ath',
        risk: 'safe',
        analyzedAt: '2025-01-01T00:00:00Z',
      });
      expect(result.provenance!.auditSnapshot.capturedAt).toBeDefined();

      // Verify the file was actually written
      const provenancePath = join(TEST_DIR, 'skills', 'my-skill', '.provenance.json');
      expect(existsSync(provenancePath)).toBe(true);

      const storedProvenance = JSON.parse(readFileSync(provenancePath, 'utf-8'));
      expect(storedProvenance.provider).toBe('skills.sh');
      expect(storedProvenance.source).toBe('test-org/test-repo');
    } finally {
      mockSpawn.mockRestore();
    }
  });

  test('provenance includes only dimensions present in the audit', async () => {
    const originalSpawn = Bun.spawn;
    const mockSpawn = spyOn(Bun, 'spawn').mockImplementation((..._args: unknown[]) => {
      simulateSuccessfulInstall('my-skill');

      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('OK'));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) { controller.close(); },
        }),
        exited: Promise.resolve(0),
        pid: 12345,
        kill: () => {},
      } as unknown as ReturnType<typeof originalSpawn>;
    });

    try {
      // Only snyk dimension present
      const candidate = makeCandidate({
        audit: {
          snyk: { risk: 'safe', analyzedAt: '2025-06-01T00:00:00Z' },
        },
        overallRisk: 'safe',
      });

      const result = await skillsshInstall({
        candidate,
        securityDecision: makeProceedDecision(),
      });

      expect(result.success).toBe(true);
      expect(result.provenance!.auditSnapshot.dimensions).toHaveLength(1);
      expect(result.provenance!.auditSnapshot.dimensions[0].provider).toBe('snyk');
    } finally {
      mockSpawn.mockRestore();
    }
  });

  test('does not store provenance on failed install', async () => {
    const result = await skillsshInstall({
      candidate: makeCandidate(),
      securityDecision: makeDoNotRecommendDecision(),
      userOverride: false,
    });

    expect(result.success).toBe(false);
    expect(result.provenance).toBeUndefined();

    const provenancePath = join(TEST_DIR, 'skills', 'my-skill', '.provenance.json');
    expect(existsSync(provenancePath)).toBe(false);
  });
});

// ─── Subprocess error handling ───────────────────────────────────────────────────

describe('skillsshInstall error handling', () => {
  test('returns error when subprocess exits with non-zero code', async () => {
    const originalSpawn = Bun.spawn;
    const mockSpawn = spyOn(Bun, 'spawn').mockImplementation((..._args: unknown[]) => {
      return {
        stdout: new ReadableStream({
          start(controller) { controller.close(); },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Error: skill not found'));
            controller.close();
          },
        }),
        exited: Promise.resolve(1),
        pid: 12345,
        kill: () => {},
      } as unknown as ReturnType<typeof originalSpawn>;
    });

    try {
      const result = await skillsshInstall({
        candidate: makeCandidate(),
        securityDecision: makeProceedDecision(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Error: skill not found');
    } finally {
      mockSpawn.mockRestore();
    }
  });

  test('returns error when SKILL.md is not found after install', async () => {
    const originalSpawn = Bun.spawn;
    // Simulate subprocess success but without creating SKILL.md
    const mockSpawn = spyOn(Bun, 'spawn').mockImplementation((..._args: unknown[]) => {
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Done'));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) { controller.close(); },
        }),
        exited: Promise.resolve(0),
        pid: 12345,
        kill: () => {},
      } as unknown as ReturnType<typeof originalSpawn>;
    });

    try {
      const result = await skillsshInstall({
        candidate: makeCandidate(),
        securityDecision: makeProceedDecision(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('SKILL.md not found');
    } finally {
      mockSpawn.mockRestore();
    }
  });

  test('handles subprocess exceptions gracefully', async () => {
    const mockSpawn = spyOn(Bun, 'spawn').mockImplementation(() => {
      throw new Error('spawn failed: command not found');
    });

    try {
      const result = await skillsshInstall({
        candidate: makeCandidate(),
        securityDecision: makeProceedDecision(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('spawn failed: command not found');
    } finally {
      mockSpawn.mockRestore();
    }
  });
});

// ─── Managed store provenance reading ────────────────────────────────────────────

describe('readSkillProvenance', () => {
  test('reads provenance from .provenance.json', () => {
    const skillDir = join(TEST_DIR, 'skills', 'test-skill');
    mkdirSync(skillDir, { recursive: true });

    const provenance: SkillsShProvenance = {
      provider: 'skills.sh',
      source: 'org/repo',
      skillId: 'test-skill',
      sourceUrl: 'https://skills.sh/skills/org/repo/test-skill',
      auditSnapshot: {
        overallRisk: 'low',
        dimensions: [
          { provider: 'ath', risk: 'safe', analyzedAt: '2025-01-01T00:00:00Z' },
        ],
        capturedAt: '2025-01-15T00:00:00Z',
      },
    };

    writeFileSync(join(skillDir, '.provenance.json'), JSON.stringify(provenance, null, 2), 'utf-8');

    const result = readSkillProvenance('test-skill');
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('skills.sh');
    expect(result!.source).toBe('org/repo');
    expect(result!.skillId).toBe('test-skill');
    expect(result!.auditSnapshot!.overallRisk).toBe('low');
  });

  test('returns null when no provenance file exists', () => {
    const skillDir = join(TEST_DIR, 'skills', 'no-provenance');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# No provenance\n', 'utf-8');

    const result = readSkillProvenance('no-provenance');
    expect(result).toBeNull();
  });

  test('returns null for malformed provenance JSON', () => {
    const skillDir = join(TEST_DIR, 'skills', 'bad-provenance');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, '.provenance.json'), '{not valid json!!!', 'utf-8');

    const result = readSkillProvenance('bad-provenance');
    expect(result).toBeNull();
  });
});
