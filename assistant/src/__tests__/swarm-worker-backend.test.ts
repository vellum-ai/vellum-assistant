import { describe, test, expect } from 'bun:test';
import {
  getProfilePolicy,
  roleToProfile,
} from '../swarm/worker-backend.js';
import type { WorkerProfile } from '../swarm/worker-backend.js';

describe('roleToProfile', () => {
  test('maps researcher role to researcher profile', () => {
    expect(roleToProfile('researcher')).toBe('researcher');
  });

  test('maps coder role to coder profile', () => {
    expect(roleToProfile('coder')).toBe('coder');
  });

  test('maps reviewer role to reviewer profile', () => {
    expect(roleToProfile('reviewer')).toBe('reviewer');
  });

  test('maps router role to general profile', () => {
    expect(roleToProfile('router')).toBe('general');
  });
});

describe('getProfilePolicy', () => {
  const READ_ONLY_TOOLS = [
    'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'LS',
    'Bash(grep *)', 'Bash(rg *)', 'Bash(find *)',
  ];

  const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

  describe('general profile', () => {
    const policy = getProfilePolicy('general');

    test('allows read-only tools', () => {
      for (const tool of READ_ONLY_TOOLS) {
        expect(policy.allow.has(tool)).toBe(true);
      }
    });

    test('has no hard denies', () => {
      expect(policy.deny.size).toBe(0);
    });

    test('requires approval for write tools and Bash', () => {
      for (const tool of WRITE_TOOLS) {
        expect(policy.approvalRequired.has(tool)).toBe(true);
      }
      expect(policy.approvalRequired.has('Bash')).toBe(true);
    });
  });

  describe('researcher profile', () => {
    const policy = getProfilePolicy('researcher');

    test('allows read-only tools', () => {
      for (const tool of READ_ONLY_TOOLS) {
        expect(policy.allow.has(tool)).toBe(true);
      }
    });

    test('denies write tools and Bash', () => {
      for (const tool of WRITE_TOOLS) {
        expect(policy.deny.has(tool)).toBe(true);
      }
      expect(policy.deny.has('Bash')).toBe(true);
    });
  });

  describe('coder profile', () => {
    const policy = getProfilePolicy('coder');

    test('allows read-only tools', () => {
      for (const tool of READ_ONLY_TOOLS) {
        expect(policy.allow.has(tool)).toBe(true);
      }
    });

    test('has no hard denies', () => {
      expect(policy.deny.size).toBe(0);
    });

    test('requires approval for write tools and Bash', () => {
      for (const tool of WRITE_TOOLS) {
        expect(policy.approvalRequired.has(tool)).toBe(true);
      }
      expect(policy.approvalRequired.has('Bash')).toBe(true);
    });
  });

  describe('reviewer profile', () => {
    const policy = getProfilePolicy('reviewer');

    test('allows read-only tools', () => {
      for (const tool of READ_ONLY_TOOLS) {
        expect(policy.allow.has(tool)).toBe(true);
      }
    });

    test('denies write tools and Bash', () => {
      for (const tool of WRITE_TOOLS) {
        expect(policy.deny.has(tool)).toBe(true);
      }
      expect(policy.deny.has('Bash')).toBe(true);
    });
  });

  test('all profiles allow the same read-only tool set', () => {
    const profiles: WorkerProfile[] = ['general', 'researcher', 'coder', 'reviewer'];
    for (const profile of profiles) {
      const policy = getProfilePolicy(profile);
      for (const tool of READ_ONLY_TOOLS) {
        expect(policy.allow.has(tool)).toBe(true);
      }
    }
  });

  test('denied tools are never also in allow set', () => {
    const profiles: WorkerProfile[] = ['general', 'researcher', 'coder', 'reviewer'];
    for (const profile of profiles) {
      const policy = getProfilePolicy(profile);
      for (const tool of policy.deny) {
        expect(policy.allow.has(tool)).toBe(false);
      }
    }
  });
});
