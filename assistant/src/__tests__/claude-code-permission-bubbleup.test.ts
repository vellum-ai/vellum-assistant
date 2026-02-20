import { describe, test, expect } from 'bun:test';
import { getProfilePolicy } from '../swarm/worker-backend.js';
import type { ProfilePolicy } from '../swarm/worker-backend.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simulate the 5-tier permission check from claude-code.ts canUseTool callback.
 * Returns the decision that would be made for a given tool under a given policy.
 */
function checkToolPermission(
  policy: ProfilePolicy,
  toolName: string,
): 'deny' | 'allow' | 'approval_required' | 'default_allow' {
  // 1. Deny-list: block unconditionally
  if (policy.deny.has(toolName)) return 'deny';
  // 2. Allow-list: auto-approve
  if (policy.allow.has(toolName)) return 'allow';
  // 3. Approval-required: bubble up to user
  if (policy.approvalRequired.has(toolName)) return 'approval_required';
  // 4. Default: allow (backward compat for tools not in any set)
  return 'default_allow';
}

// ---------------------------------------------------------------------------
// Tests — general profile (5-tier permission check)
// ---------------------------------------------------------------------------

describe('permission bubble-up — general profile', () => {
  const policy = getProfilePolicy('general');

  test('tool in deny set is denied', () => {
    // general profile has an empty deny set, so we verify the logic
    // with a synthetic deny entry to prove the tier works
    const customPolicy: ProfilePolicy = {
      allow: new Set(policy.allow),
      deny: new Set(['DangerousTool']),
      approvalRequired: new Set(policy.approvalRequired),
    };
    expect(checkToolPermission(customPolicy, 'DangerousTool')).toBe('deny');
  });

  test('tool in allow set is allowed', () => {
    // Read is in the allow set for the general profile
    expect(policy.allow.has('Read')).toBe(true);
    expect(checkToolPermission(policy, 'Read')).toBe('allow');
  });

  test('tool in approvalRequired set requires confirmation', () => {
    // Bash is in approvalRequired for the general profile
    expect(policy.approvalRequired.has('Bash')).toBe(true);
    expect(checkToolPermission(policy, 'Bash')).toBe('approval_required');
  });

  test('tool not in any set defaults to allowed', () => {
    // A completely unknown tool should fall through to default_allow
    expect(policy.deny.has('SomeUnknownTool')).toBe(false);
    expect(policy.allow.has('SomeUnknownTool')).toBe(false);
    expect(policy.approvalRequired.has('SomeUnknownTool')).toBe(false);
    expect(checkToolPermission(policy, 'SomeUnknownTool')).toBe('default_allow');
  });

  test('deny takes precedence over allow and approvalRequired', () => {
    // If a tool appears in multiple sets, deny should win because it is checked first
    const customPolicy: ProfilePolicy = {
      allow: new Set(['ConflictTool']),
      deny: new Set(['ConflictTool']),
      approvalRequired: new Set(['ConflictTool']),
    };
    expect(checkToolPermission(customPolicy, 'ConflictTool')).toBe('deny');
  });

  test('allow takes precedence over approvalRequired', () => {
    // If a tool appears in both allow and approvalRequired, allow wins (checked second)
    const customPolicy: ProfilePolicy = {
      allow: new Set(['OverlapTool']),
      deny: new Set(),
      approvalRequired: new Set(['OverlapTool']),
    };
    expect(checkToolPermission(customPolicy, 'OverlapTool')).toBe('allow');
  });

  test('general profile read-only tools are all in allow set', () => {
    const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'LS'];
    for (const tool of readOnlyTools) {
      expect(policy.allow.has(tool)).toBe(true);
      expect(checkToolPermission(policy, tool)).toBe('allow');
    }
  });

  test('general profile write tools are in approvalRequired', () => {
    const writeTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
    for (const tool of writeTools) {
      expect(policy.approvalRequired.has(tool)).toBe(true);
      expect(checkToolPermission(policy, tool)).toBe('approval_required');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — worker profile
// ---------------------------------------------------------------------------

describe('permission bubble-up — worker profile', () => {
  const policy = getProfilePolicy('worker');

  test('all tools in allow set, nothing in deny or approvalRequired', () => {
    expect(policy.deny.size).toBe(0);
    expect(policy.approvalRequired.size).toBe(0);
    expect(policy.allow.size).toBeGreaterThan(0);
  });

  test('Bash is in allow (no approval needed)', () => {
    expect(checkToolPermission(policy, 'Bash')).toBe('allow');
  });

  test('Write tools are in allow (no approval needed)', () => {
    const writeTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
    for (const tool of writeTools) {
      expect(checkToolPermission(policy, tool)).toBe('allow');
    }
  });

  test('Task is in allow', () => {
    expect(policy.allow.has('Task')).toBe(true);
    expect(checkToolPermission(policy, 'Task')).toBe('allow');
  });

  test('read-only tools are in allow', () => {
    const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'LS'];
    for (const tool of readOnlyTools) {
      expect(checkToolPermission(policy, tool)).toBe('allow');
    }
  });

  test('unknown tool defaults to allowed (not in any set)', () => {
    expect(checkToolPermission(policy, 'SomeFutureTool')).toBe('default_allow');
  });
});

// ---------------------------------------------------------------------------
// Tests — researcher profile
// ---------------------------------------------------------------------------

describe('permission bubble-up — researcher profile', () => {
  const policy = getProfilePolicy('researcher');

  test('Bash is in deny set', () => {
    expect(policy.deny.has('Bash')).toBe(true);
    expect(checkToolPermission(policy, 'Bash')).toBe('deny');
  });

  test('Write tools are in deny set', () => {
    const writeTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
    for (const tool of writeTools) {
      expect(policy.deny.has(tool)).toBe(true);
      expect(checkToolPermission(policy, tool)).toBe('deny');
    }
  });

  test('read-only tools are in allow set', () => {
    const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'LS'];
    for (const tool of readOnlyTools) {
      expect(policy.allow.has(tool)).toBe(true);
      expect(checkToolPermission(policy, tool)).toBe('allow');
    }
  });

  test('approvalRequired is empty', () => {
    expect(policy.approvalRequired.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — coder profile
// ---------------------------------------------------------------------------

describe('permission bubble-up — coder profile', () => {
  const policy = getProfilePolicy('coder');

  test('Bash is in approvalRequired set', () => {
    expect(policy.approvalRequired.has('Bash')).toBe(true);
    expect(checkToolPermission(policy, 'Bash')).toBe('approval_required');
  });

  test('Write tools are in approvalRequired set', () => {
    const writeTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
    for (const tool of writeTools) {
      expect(policy.approvalRequired.has(tool)).toBe(true);
      expect(checkToolPermission(policy, tool)).toBe('approval_required');
    }
  });

  test('read-only tools are in allow set', () => {
    const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'LS'];
    for (const tool of readOnlyTools) {
      expect(policy.allow.has(tool)).toBe(true);
      expect(checkToolPermission(policy, tool)).toBe('allow');
    }
  });

  test('deny set is empty', () => {
    expect(policy.deny.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — reviewer profile (same access pattern as researcher)
// ---------------------------------------------------------------------------

describe('permission bubble-up — reviewer profile', () => {
  const policy = getProfilePolicy('reviewer');

  test('Bash is in deny set', () => {
    expect(policy.deny.has('Bash')).toBe(true);
    expect(checkToolPermission(policy, 'Bash')).toBe('deny');
  });

  test('Write tools are in deny set', () => {
    const writeTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
    for (const tool of writeTools) {
      expect(policy.deny.has(tool)).toBe(true);
      expect(checkToolPermission(policy, tool)).toBe('deny');
    }
  });

  test('read-only tools are in allow set', () => {
    const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'LS'];
    for (const tool of readOnlyTools) {
      expect(policy.allow.has(tool)).toBe(true);
      expect(checkToolPermission(policy, tool)).toBe('allow');
    }
  });

  test('approvalRequired is empty', () => {
    expect(policy.approvalRequired.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — default/fallback profile
// ---------------------------------------------------------------------------

describe('permission bubble-up — default fallback', () => {
  test('unknown profile name falls back to general-like policy', () => {
    // TypeScript types restrict this, but at runtime an invalid string would
    // hit the default branch which mirrors "general"
    const policy = getProfilePolicy('nonexistent' as never);
    expect(policy.allow.has('Read')).toBe(true);
    expect(policy.deny.size).toBe(0);
    expect(policy.approvalRequired.has('Bash')).toBe(true);
  });
});
