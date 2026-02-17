import { describe, test, expect, beforeEach, mock } from 'bun:test';
import * as realFs from 'node:fs';
import type { Message, ToolDefinition } from '../providers/types.js';
import type { SkillSummary, SkillToolManifest } from '../config/skills.js';
import type { Tool } from '../tools/types.js';
import { RiskLevel } from '../permissions/types.js';

// ---------------------------------------------------------------------------
// Mock state — controlled by tests
// ---------------------------------------------------------------------------

let mockCatalog: SkillSummary[] = [];
let mockManifests: Record<string, SkillToolManifest | null> = {};
let mockRegisteredTools: Map<string, Tool[]> = new Map();
let mockUnregisteredSkillIds: string[] = [];

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

mock.module('../config/skills.js', () => ({
  loadSkillCatalog: () => mockCatalog,
}));

mock.module('../skills/active-skill-tools.js', () => ({
  deriveActiveSkillIds: (messages: Message[]) => {
    // Two-pass approach matching real implementation:
    // 1. Collect tool_use IDs where name === 'skill_load'
    const skillLoadUseIds = new Set<string>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.name === 'skill_load') {
          skillLoadUseIds.add(block.id);
        }
      }
    }

    // 2. Parse markers only from tool_result blocks whose tool_use_id matches
    const re = /<loaded_skill\s+id="([^"]+)"\s*\/>/g;
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type !== 'tool_result') continue;
        if (!skillLoadUseIds.has(block.tool_use_id)) continue;
        const text = block.content;
        if (!text) continue;
        for (const match of text.matchAll(re)) {
          if (!seen.has(match[1])) {
            seen.add(match[1]);
            ids.push(match[1]);
          }
        }
      }
    }
    return ids;
  },
}));

mock.module('../skills/tool-manifest.js', () => ({
  parseToolManifestFile: (filePath: string) => {
    // Extract skill ID from path: /skills/<id>/TOOLS.json → <id>
    const parts = filePath.split('/');
    const skillId = parts[parts.length - 2];
    const manifest = mockManifests[skillId];
    if (!manifest) {
      throw new Error(`Mock: no manifest for skill "${skillId}"`);
    }
    return manifest;
  },
}));

mock.module('../tools/skills/skill-tool-factory.js', () => ({
  createSkillToolsFromManifest: (
    entries: SkillToolManifest['tools'],
    skillId: string,
    _skillDir: string,
  ): Tool[] => {
    return entries.map((entry) => ({
      name: entry.name,
      description: entry.description,
      category: entry.category,
      defaultRiskLevel: RiskLevel.Medium,
      origin: 'skill' as const,
      ownerSkillId: skillId,
      getDefinition: () => ({
        name: entry.name,
        description: entry.description,
        input_schema: entry.input_schema as object,
      }),
      execute: async () => ({ content: '', isError: false }),
    }));
  },
}));

mock.module('../tools/registry.js', () => ({
  registerSkillTools: (tools: Tool[]) => {
    for (const tool of tools) {
      const skillId = tool.ownerSkillId!;
      const existing = mockRegisteredTools.get(skillId) ?? [];
      existing.push(tool);
      mockRegisteredTools.set(skillId, existing);
    }
  },
  unregisterSkillTools: (skillId: string) => {
    mockUnregisteredSkillIds.push(skillId);
    mockRegisteredTools.delete(skillId);
  },
  getSkillToolNames: () => {
    const names: string[] = [];
    for (const tools of mockRegisteredTools.values()) {
      for (const tool of tools) {
        names.push(tool.name);
      }
    }
    return names;
  },
}));

// Stub existsSync so TOOLS.json existence checks pass for skills that have manifests
mock.module('node:fs', () => ({
  ...realFs,
  existsSync: (p: string) => {
    if (typeof p === 'string' && p.endsWith('TOOLS.json')) {
      const parts = p.split('/');
      const skillId = parts[parts.length - 2];
      return skillId in mockManifests;
    }
    return realFs.existsSync(p);
  },
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { projectSkillTools, resetSkillToolProjection } = await import(
  '../daemon/session-skill-tools.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(id: string, dir?: string): SkillSummary {
  return {
    id,
    name: id,
    description: `Skill ${id}`,
    directoryPath: dir ?? `/skills/${id}`,
    skillFilePath: `/skills/${id}/SKILL.md`,
    userInvocable: true,
    disableModelInvocation: false,
    source: 'managed',
  };
}

function makeManifest(toolNames: string[]): SkillToolManifest {
  return {
    version: 1,
    tools: toolNames.map((name) => ({
      name,
      description: `Tool ${name}`,
      category: 'test',
      risk: 'medium' as const,
      input_schema: { type: 'object', properties: {} },
      executor: 'run.ts',
      execution_target: 'host' as const,
    })),
  };
}

let toolUseCounter = 0;

/**
 * Creates a pair of messages representing a skill_load tool_use followed by
 * its tool_result with the given content (typically a `<loaded_skill>` marker).
 */
function skillLoadMessages(content: string): Message[] {
  const id = `sl-${++toolUseCounter}`;
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'skill_load', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('projectSkillTools', () => {
  let sessionState: Set<string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    sessionState = new Set<string>();
  });

  test('no active skills returns empty projection', () => {
    const result = projectSkillTools([], { previouslyActiveSkillIds: sessionState });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames.size).toBe(0);
  });

  test('active skill with valid manifest returns tool definitions', () => {
    mockCatalog = [makeSkill('deploy')];
    mockManifests = { deploy: makeManifest(['deploy_run', 'deploy_status']) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    const result = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    expect(result.toolDefinitions).toHaveLength(2);
    expect(result.toolDefinitions.map((d) => d.name)).toEqual([
      'deploy_run',
      'deploy_status',
    ]);
    expect(result.allowedToolNames).toEqual(
      new Set(['deploy_run', 'deploy_status']),
    );
  });

  test('multiple active skills are projected', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page']),
    };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];

    const result = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    expect(result.toolDefinitions).toHaveLength(2);
    expect(result.allowedToolNames).toEqual(
      new Set(['deploy_run', 'oncall_page']),
    );
  });

  test('preactivated skill IDs are included', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page']),
    };

    // Only deploy is in history; oncall is preactivated
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    const result = projectSkillTools(history, {
      preactivatedSkillIds: ['oncall'],
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toHaveLength(2);
    expect(result.allowedToolNames).toEqual(
      new Set(['deploy_run', 'oncall_page']),
    );
  });

  test('skill deactivation: previously active skill is unregistered when removed from history', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page']),
    };

    // First turn: both skills active
    const history1: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    projectSkillTools(history1, { previouslyActiveSkillIds: sessionState });

    // Second turn: only deploy remains active (oncall marker gone)
    mockUnregisteredSkillIds = [];
    const history2: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];
    const result = projectSkillTools(history2, { previouslyActiveSkillIds: sessionState });

    expect(mockUnregisteredSkillIds).toContain('oncall');
    expect(result.allowedToolNames).toEqual(new Set(['deploy_run']));
  });

  test('invalid/missing manifest is gracefully handled', () => {
    mockCatalog = [makeSkill('broken')];
    // No manifest registered for "broken", so parseToolManifestFile will throw

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="broken" />'),
    ];

    const result = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    // Should not throw, just return empty projection for that skill
    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames.size).toBe(0);
  });

  test('skill ID not in catalog is gracefully skipped', () => {
    mockCatalog = []; // empty catalog
    mockManifests = {};

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="nonexistent" />'),
    ];

    const result = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames.size).toBe(0);
  });

  test('preactivated IDs merge with context-derived IDs (dedup)', () => {
    mockCatalog = [makeSkill('deploy')];
    mockManifests = { deploy: makeManifest(['deploy_run']) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // deploy is both in history AND preactivated — should not duplicate
    const result = projectSkillTools(history, {
      preactivatedSkillIds: ['deploy'],
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toHaveLength(1);
    expect(result.allowedToolNames).toEqual(new Set(['deploy_run']));
  });

  test('no markers in history with preactivated IDs still projects tools', () => {
    mockCatalog = [makeSkill('oncall')];
    mockManifests = { oncall: makeManifest(['oncall_page']) };

    const result = projectSkillTools([], {
      preactivatedSkillIds: ['oncall'],
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toHaveLength(1);
    expect(result.allowedToolNames).toEqual(new Set(['oncall_page']));
  });

  test('concurrent sessions do not interfere with each other', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page']),
    };

    const sessionA = new Set<string>();
    const sessionB = new Set<string>();

    // Session A activates deploy
    const historyA: Message[] = [...skillLoadMessages('<loaded_skill id="deploy" />')];
    const resultA = projectSkillTools(historyA, { previouslyActiveSkillIds: sessionA });
    expect(resultA.allowedToolNames.has('deploy_run')).toBe(true);

    // Session B activates oncall — should NOT unregister deploy from session A
    mockUnregisteredSkillIds = [];
    const historyB: Message[] = [...skillLoadMessages('<loaded_skill id="oncall" />')];
    projectSkillTools(historyB, { previouslyActiveSkillIds: sessionB });
    expect(mockUnregisteredSkillIds).not.toContain('deploy');

    // Session A's state should still track deploy
    expect(sessionA.has('deploy')).toBe(true);
    expect(sessionB.has('oncall')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveTools callback integration tests
// ---------------------------------------------------------------------------

describe('resolveTools callback (session wiring)', () => {
  // Simulates the resolveTools callback wired in the Session constructor:
  //   (history) => [...baseToolDefs, ...projectSkillTools(history).toolDefinitions]
  const baseToolDefs: ToolDefinition[] = [
    { name: 'file_read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
    { name: 'bash', description: 'Run a shell command', input_schema: { type: 'object', properties: {} } },
  ];

  let sessionState: Set<string>;

  function makeResolveTools(base: ToolDefinition[]) {
    return (history: Message[]): ToolDefinition[] => {
      const projection = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
      return [...base, ...projection.toolDefinitions];
    };
  }

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    sessionState = new Set<string>();
  });

  test('returns only base tools when no skills are active', () => {
    const resolveTools = makeResolveTools(baseToolDefs);
    const result = resolveTools([]);

    expect(result).toHaveLength(2);
    expect(result.map((d) => d.name)).toEqual(['file_read', 'bash']);
  });

  test('combines base tools with projected skill tools', () => {
    mockCatalog = [makeSkill('deploy')];
    mockManifests = { deploy: makeManifest(['deploy_run', 'deploy_status']) };

    const resolveTools = makeResolveTools(baseToolDefs);
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    const result = resolveTools(history);

    expect(result).toHaveLength(4);
    expect(result.map((d) => d.name)).toEqual([
      'file_read',
      'bash',
      'deploy_run',
      'deploy_status',
    ]);
  });

  test('skill tools appear after base tools and do not replace them', () => {
    mockCatalog = [makeSkill('oncall')];
    mockManifests = { oncall: makeManifest(['oncall_page']) };

    const resolveTools = makeResolveTools(baseToolDefs);
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];

    const result = resolveTools(history);

    // Base tools come first, skill tools are appended
    expect(result[0].name).toBe('file_read');
    expect(result[1].name).toBe('bash');
    expect(result[2].name).toBe('oncall_page');
  });

  test('multiple skills add all their tools alongside base tools', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page', 'oncall_ack']),
    };

    const resolveTools = makeResolveTools(baseToolDefs);
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];

    const result = resolveTools(history);

    expect(result).toHaveLength(5);
    const names = result.map((d) => d.name);
    expect(names).toContain('file_read');
    expect(names).toContain('bash');
    expect(names).toContain('deploy_run');
    expect(names).toContain('oncall_page');
    expect(names).toContain('oncall_ack');
  });
});

// ---------------------------------------------------------------------------
// Tests — allowed tool set merging with core tools
// ---------------------------------------------------------------------------

describe('allowed tool set merging', () => {
  const CORE_TOOL_NAMES = new Set(['bash', 'file_read', 'file_write', 'file_edit']);
  let sessionState: Set<string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    sessionState = new Set<string>();
  });

  /**
   * Simulates the merging logic from session.ts:
   * union of core tool names + projected skill tool names.
   */
  function buildAllowedSet(projection: { allowedToolNames: Set<string> }): Set<string> {
    const merged = new Set(CORE_TOOL_NAMES);
    for (const name of projection.allowedToolNames) {
      merged.add(name);
    }
    return merged;
  }

  test('core tools are always included even with no active skills', () => {
    const projection = projectSkillTools([], { previouslyActiveSkillIds: sessionState });
    const allowed = buildAllowedSet(projection);

    for (const core of CORE_TOOL_NAMES) {
      expect(allowed.has(core)).toBe(true);
    }
  });

  test('active skill tools are included alongside core tools', () => {
    mockCatalog = [makeSkill('deploy')];
    mockManifests = { deploy: makeManifest(['deploy_run', 'deploy_status']) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    const projection = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    const allowed = buildAllowedSet(projection);

    // Core tools present
    for (const core of CORE_TOOL_NAMES) {
      expect(allowed.has(core)).toBe(true);
    }
    // Active skill tools present
    expect(allowed.has('deploy_run')).toBe(true);
    expect(allowed.has('deploy_status')).toBe(true);
  });

  test('inactive skill tools are NOT in the allowed set', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page']),
    };

    // Only deploy is active
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    const projection = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    const allowed = buildAllowedSet(projection);

    expect(allowed.has('deploy_run')).toBe(true);
    // oncall_page is not active — not in projection, not in allowed set
    expect(allowed.has('oncall_page')).toBe(false);
  });

  test('allowed set updates when skills activate and deactivate', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page']),
    };

    // Turn 1: both active
    const history1: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    const projection1 = projectSkillTools(history1, { previouslyActiveSkillIds: sessionState });
    const allowed1 = buildAllowedSet(projection1);

    expect(allowed1.has('deploy_run')).toBe(true);
    expect(allowed1.has('oncall_page')).toBe(true);

    // Turn 2: only deploy remains
    const history2: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];
    const projection2 = projectSkillTools(history2, { previouslyActiveSkillIds: sessionState });
    const allowed2 = buildAllowedSet(projection2);

    expect(allowed2.has('deploy_run')).toBe(true);
    expect(allowed2.has('oncall_page')).toBe(false);
    // Core tools still present
    for (const core of CORE_TOOL_NAMES) {
      expect(allowed2.has(core)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end mid-run activation tests
// ---------------------------------------------------------------------------

describe('mid-run skill tool activation (end-to-end)', () => {
  const baseToolDefs: ToolDefinition[] = [
    { name: 'file_read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
    { name: 'bash', description: 'Run a shell command', input_schema: { type: 'object', properties: {} } },
  ];

  const CORE_TOOL_NAMES = new Set(['bash', 'file_read', 'file_write', 'file_edit']);
  let sessionState: Set<string>;

  function makeResolveTools(base: ToolDefinition[]) {
    return (history: Message[]) => {
      const projection = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
      return {
        toolDefinitions: [...base, ...projection.toolDefinitions],
        allowedToolNames: new Set([...CORE_TOOL_NAMES, ...projection.allowedToolNames]),
      };
    };
  }

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    sessionState = new Set<string>();
  });

  test('Turn 1 calls skill_load → Turn 2 sees added tool', () => {
    mockCatalog = [makeSkill('deploy')];
    mockManifests = { deploy: makeManifest(['deploy_run']) };

    const resolveTools = makeResolveTools(baseToolDefs);

    // Turn 1: no skill markers in history yet
    const historyTurn1: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Please deploy' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me load the deploy skill.' }] },
    ];

    const turn1Result = resolveTools(historyTurn1);
    expect(turn1Result.toolDefinitions.map((d) => d.name)).toEqual(['file_read', 'bash']);
    expect(turn1Result.allowedToolNames.has('deploy_run')).toBe(false);

    // Simulate skill_load output appended as a tool result in the same run
    const historyTurn2: Message[] = [
      ...historyTurn1,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'skill-load-1', name: 'skill_load', input: { skill_id: 'deploy' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'skill-load-1', content: '<loaded_skill id="deploy" />' },
        ],
      },
    ];

    const turn2Result = resolveTools(historyTurn2);
    expect(turn2Result.toolDefinitions.map((d) => d.name)).toEqual([
      'file_read',
      'bash',
      'deploy_run',
    ]);
    expect(turn2Result.allowedToolNames.has('deploy_run')).toBe(true);
  });

  test('activation succeeds without requiring a new user message', () => {
    mockCatalog = [makeSkill('monitor')];
    mockManifests = { monitor: makeManifest(['monitor_check', 'monitor_alert']) };

    const resolveTools = makeResolveTools(baseToolDefs);

    // History contains only the initial user message and the assistant's
    // tool_use that triggered skill_load, followed by the tool result.
    // No second user message is present — the agent loop re-projects
    // tools between turns within the same run.
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Monitor the service' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'skill_load', input: { skill_id: 'monitor' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: '<loaded_skill id="monitor" />' },
        ],
      },
    ];

    const result = resolveTools(history);

    // Skill tools appear without needing another user message
    expect(result.toolDefinitions.map((d) => d.name)).toContain('monitor_check');
    expect(result.toolDefinitions.map((d) => d.name)).toContain('monitor_alert');
    expect(result.allowedToolNames.has('monitor_check')).toBe(true);
    expect(result.allowedToolNames.has('monitor_alert')).toBe(true);

    // Core tools remain accessible
    for (const core of CORE_TOOL_NAMES) {
      expect(result.allowedToolNames.has(core)).toBe(true);
    }
  });

  test('multiple skills can activate in sequence across turns', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall'), makeSkill('metrics')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page']),
      metrics: makeManifest(['metrics_query', 'metrics_dashboard']),
    };

    const resolveTools = makeResolveTools(baseToolDefs);

    // Step 1: Load skill A (deploy)
    const historyAfterA: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'I need to deploy and check oncall' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'skill_load', input: { skill_id: 'deploy' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: '<loaded_skill id="deploy" />' },
        ],
      },
    ];

    const resultA = resolveTools(historyAfterA);
    const namesA = resultA.toolDefinitions.map((d) => d.name);
    expect(namesA).toContain('deploy_run');
    expect(namesA).not.toContain('oncall_page');
    expect(namesA).not.toContain('metrics_query');

    // Step 2: Load skill B (oncall) — deploy should remain active
    const historyAfterB: Message[] = [
      ...historyAfterA,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-2', name: 'skill_load', input: { skill_id: 'oncall' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-2', content: '<loaded_skill id="oncall" />' },
        ],
      },
    ];

    const resultB = resolveTools(historyAfterB);
    const namesB = resultB.toolDefinitions.map((d) => d.name);
    expect(namesB).toContain('deploy_run');
    expect(namesB).toContain('oncall_page');
    expect(namesB).not.toContain('metrics_query');

    // Step 3: Load skill C (metrics) — all three should be active
    const historyAfterC: Message[] = [
      ...historyAfterB,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-3', name: 'skill_load', input: { skill_id: 'metrics' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-3', content: '<loaded_skill id="metrics" />' },
        ],
      },
    ];

    const resultC = resolveTools(historyAfterC);
    const namesC = resultC.toolDefinitions.map((d) => d.name);
    expect(namesC).toContain('deploy_run');
    expect(namesC).toContain('oncall_page');
    expect(namesC).toContain('metrics_query');
    expect(namesC).toContain('metrics_dashboard');

    // Verify allowed tool names include all skill tools plus core tools
    expect(resultC.allowedToolNames.has('deploy_run')).toBe(true);
    expect(resultC.allowedToolNames.has('oncall_page')).toBe(true);
    expect(resultC.allowedToolNames.has('metrics_query')).toBe(true);
    expect(resultC.allowedToolNames.has('metrics_dashboard')).toBe(true);
    for (const core of CORE_TOOL_NAMES) {
      expect(resultC.allowedToolNames.has(core)).toBe(true);
    }
  });
});

// Context-derived deactivation regression tests
// ---------------------------------------------------------------------------

describe('context-derived deactivation regression', () => {
  const baseToolDefs: ToolDefinition[] = [
    { name: 'file_read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
    { name: 'bash', description: 'Run a shell command', input_schema: { type: 'object', properties: {} } },
  ];

  const CORE_TOOL_NAMES = new Set(['bash', 'file_read', 'file_write', 'file_edit']);
  let sessionState: Set<string>;

  function makeResolveTools(base: ToolDefinition[]) {
    return (history: Message[]) => {
      const projection = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
      return {
        toolDefinitions: [...base, ...projection.toolDefinitions],
        allowedToolNames: new Set([...CORE_TOOL_NAMES, ...projection.allowedToolNames]),
      };
    };
  }

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    sessionState = new Set<string>();
  });

  test('tool definitions shrink when skill load marker is removed from history', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page', 'oncall_ack']),
    };

    const resolveTools = makeResolveTools(baseToolDefs);

    // Turn 1: both skills active
    const history1: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    const result1 = resolveTools(history1);
    expect(result1.toolDefinitions).toHaveLength(5); // 2 base + 3 skill tools
    expect(result1.toolDefinitions.map((d) => d.name)).toContain('oncall_page');
    expect(result1.toolDefinitions.map((d) => d.name)).toContain('oncall_ack');

    // Turn 2: oncall marker removed from history (truncated)
    const history2: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];
    const result2 = resolveTools(history2);

    // Tool definitions should only have base + deploy tools
    expect(result2.toolDefinitions).toHaveLength(3); // 2 base + 1 skill tool
    expect(result2.toolDefinitions.map((d) => d.name)).not.toContain('oncall_page');
    expect(result2.toolDefinitions.map((d) => d.name)).not.toContain('oncall_ack');
    expect(result2.toolDefinitions.map((d) => d.name)).toContain('deploy_run');
  });

  test('executor blocks the tool after deactivation — allowedToolNames excludes it', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page']),
    };

    const resolveTools = makeResolveTools(baseToolDefs);

    // Turn 1: both skills active, both tools allowed
    const history1: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    const result1 = resolveTools(history1);
    expect(result1.allowedToolNames.has('oncall_page')).toBe(true);
    expect(result1.allowedToolNames.has('deploy_run')).toBe(true);

    // Turn 2: oncall marker gone — its tool should be blocked
    const history2: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];
    const result2 = resolveTools(history2);

    // oncall_page is no longer in allowedToolNames — executor would block it
    expect(result2.allowedToolNames.has('oncall_page')).toBe(false);
    // deploy_run remains allowed
    expect(result2.allowedToolNames.has('deploy_run')).toBe(true);
    // Core tools remain allowed
    for (const core of CORE_TOOL_NAMES) {
      expect(result2.allowedToolNames.has(core)).toBe(true);
    }
  });

  test('unregisterSkillTools is called for deactivated skill', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page']),
    };

    // Turn 1: both active
    const history1: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    projectSkillTools(history1, { previouslyActiveSkillIds: sessionState });

    // Clear tracking before turn 2
    mockUnregisteredSkillIds = [];

    // Turn 2: deploy marker gone
    const history2: Message[] = [
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    projectSkillTools(history2, { previouslyActiveSkillIds: sessionState });

    expect(mockUnregisteredSkillIds).toContain('deploy');
    expect(mockUnregisteredSkillIds).not.toContain('oncall');
  });

  test('all skills deactivate when all markers leave history', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page']),
    };

    const resolveTools = makeResolveTools(baseToolDefs);

    // Turn 1: both skills active
    const history1: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    const result1 = resolveTools(history1);
    expect(result1.toolDefinitions).toHaveLength(4); // 2 base + 2 skill

    // Clear tracking before turn 2
    mockUnregisteredSkillIds = [];

    // Turn 2: all markers gone (e.g. context window fully truncated)
    const history2: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Continue working' }] },
    ];
    const result2 = resolveTools(history2);

    // Only base tools remain
    expect(result2.toolDefinitions).toHaveLength(2);
    expect(result2.toolDefinitions.map((d) => d.name)).toEqual(['file_read', 'bash']);

    // Both skills were unregistered
    expect(mockUnregisteredSkillIds).toContain('deploy');
    expect(mockUnregisteredSkillIds).toContain('oncall');

    // No skill tools in allowed set
    expect(result2.allowedToolNames.has('deploy_run')).toBe(false);
    expect(result2.allowedToolNames.has('oncall_page')).toBe(false);

    // Core tools still present
    for (const core of CORE_TOOL_NAMES) {
      expect(result2.allowedToolNames.has(core)).toBe(true);
    }
  });

  test('skill can reactivate after deactivation', () => {
    mockCatalog = [makeSkill('deploy')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
    };

    const resolveTools = makeResolveTools(baseToolDefs);

    // Turn 1: deploy active
    const history1: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];
    const result1 = resolveTools(history1);
    expect(result1.allowedToolNames.has('deploy_run')).toBe(true);

    // Turn 2: marker gone — deactivated
    const history2: Message[] = [];
    const result2 = resolveTools(history2);
    expect(result2.allowedToolNames.has('deploy_run')).toBe(false);

    // Turn 3: marker reappears — reactivated
    const history3: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];
    const result3 = resolveTools(history3);
    expect(result3.allowedToolNames.has('deploy_run')).toBe(true);
    expect(result3.toolDefinitions.map((d) => d.name)).toContain('deploy_run');
  });
});

// ---------------------------------------------------------------------------
// Slash preactivation tests
// ---------------------------------------------------------------------------

describe('slash preactivation through session processing', () => {
  let sessionState: Set<string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    sessionState = new Set<string>();
  });

  test('slash-known skill has its tools available on first projection (turn-0)', () => {
    mockCatalog = [makeSkill('deploy')];
    mockManifests = { deploy: makeManifest(['deploy_run', 'deploy_status']) };

    // Empty history — no loaded_skill markers yet. The skill is preactivated
    // via slash resolution, so its tools should be available immediately.
    const emptyHistory: Message[] = [];

    const result = projectSkillTools(emptyHistory, {
      preactivatedSkillIds: ['deploy'],
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toHaveLength(2);
    expect(result.toolDefinitions.map((d) => d.name)).toEqual([
      'deploy_run',
      'deploy_status',
    ]);
    expect(result.allowedToolNames).toEqual(
      new Set(['deploy_run', 'deploy_status']),
    );
  });

  test('preactivation is request-scoped — does not persist to unrelated runs', () => {
    mockCatalog = [makeSkill('deploy')];
    mockManifests = { deploy: makeManifest(['deploy_run']) };

    // First request: preactivated via slash command
    const result1 = projectSkillTools([], {
      preactivatedSkillIds: ['deploy'],
      previouslyActiveSkillIds: sessionState,
    });
    expect(result1.toolDefinitions).toHaveLength(1);
    expect(result1.allowedToolNames.has('deploy_run')).toBe(true);

    // Second request: no preactivation, no history markers.
    // Without preactivated IDs, the skill should not appear.
    const result2 = projectSkillTools([], { previouslyActiveSkillIds: sessionState });

    expect(result2.toolDefinitions).toHaveLength(0);
    expect(result2.allowedToolNames.has('deploy_run')).toBe(false);
  });

  test('preactivated skill tools merge with history-derived skills on turn-0', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page']),
    };

    // History has an oncall marker from a previous exchange
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];

    // deploy is preactivated via slash, oncall is from history
    const result = projectSkillTools(history, {
      preactivatedSkillIds: ['deploy'],
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toHaveLength(2);
    expect(result.allowedToolNames).toEqual(
      new Set(['deploy_run', 'oncall_page']),
    );
  });
});

// ---------------------------------------------------------------------------
// Bundled skill pipeline integration tests
// ---------------------------------------------------------------------------

const GMAIL_TOOL_NAMES = [
  'gmail_search',
  'gmail_list_messages',
  'gmail_get_message',
  'gmail_mark_read',
  'gmail_draft',
  'gmail_archive',
  'gmail_batch_archive',
  'gmail_label',
  'gmail_batch_label',
  'gmail_trash',
  'gmail_send',
  'gmail_unsubscribe',
] as const;

describe('bundled skill: gmail', () => {
  let sessionState: Set<string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    sessionState = new Set<string>();
  });

  test('gmail skill activation via loaded_skill marker projects all 12 tool definitions', () => {
    mockCatalog = [makeSkill('gmail', '/path/to/bundled-skills/gmail')];
    mockManifests = { gmail: makeManifest([...GMAIL_TOOL_NAMES]) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="gmail" />'),
    ];

    const result = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    expect(result.toolDefinitions).toHaveLength(12);
    expect(result.toolDefinitions.map((d) => d.name)).toEqual([...GMAIL_TOOL_NAMES]);
    expect(result.allowedToolNames).toEqual(new Set(GMAIL_TOOL_NAMES));
  });

  test('gmail tools are NOT available when gmail skill is not in active context', () => {
    mockCatalog = [makeSkill('gmail', '/path/to/bundled-skills/gmail')];
    mockManifests = { gmail: makeManifest([...GMAIL_TOOL_NAMES]) };

    // No loaded_skill marker for gmail in history
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];

    const result = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    expect(result.toolDefinitions).toHaveLength(0);
    expect(result.allowedToolNames.size).toBe(0);
    for (const name of GMAIL_TOOL_NAMES) {
      expect(result.allowedToolNames.has(name)).toBe(false);
    }
  });
});

describe('bundled skill: claude-code', () => {
  let sessionState: Set<string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    sessionState = new Set<string>();
  });

  test('claude-code skill activation produces claude_code tool definition', () => {
    mockCatalog = [makeSkill('claude-code', '/path/to/bundled-skills/claude-code')];
    mockManifests = { 'claude-code': makeManifest(['claude_code']) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="claude-code" />'),
    ];

    const result = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    expect(result.toolDefinitions).toHaveLength(1);
    expect(result.toolDefinitions[0].name).toBe('claude_code');
    expect(result.allowedToolNames).toEqual(new Set(['claude_code']));
  });

  test('claude_code tool is absent when claude-code skill is not active', () => {
    mockCatalog = [makeSkill('claude-code', '/path/to/bundled-skills/claude-code')];
    mockManifests = { 'claude-code': makeManifest(['claude_code']) };

    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];

    const result = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    expect(result.toolDefinitions).toHaveLength(0);
    expect(result.allowedToolNames.has('claude_code')).toBe(false);
  });
});

describe('bundled skill: weather', () => {
  let sessionState: Set<string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    sessionState = new Set<string>();
  });

  test('weather skill activation produces get_weather tool definition', () => {
    mockCatalog = [makeSkill('weather', '/path/to/bundled-skills/weather')];
    mockManifests = { weather: makeManifest(['get_weather']) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="weather" />'),
    ];

    const result = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    expect(result.toolDefinitions).toHaveLength(1);
    expect(result.toolDefinitions[0].name).toBe('get_weather');
    expect(result.allowedToolNames).toEqual(new Set(['get_weather']));
  });

  test('get_weather tool is absent when weather skill is not active', () => {
    mockCatalog = [makeSkill('weather', '/path/to/bundled-skills/weather')];
    mockManifests = { weather: makeManifest(['get_weather']) };

    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];

    const result = projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    expect(result.toolDefinitions).toHaveLength(0);
    expect(result.allowedToolNames.has('get_weather')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resetSkillToolProjection tests
// ---------------------------------------------------------------------------

describe('resetSkillToolProjection', () => {
  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
  });

  test('unregisters all tracked skills and clears the set', () => {
    mockCatalog = [makeSkill('deploy'), makeSkill('oncall')];
    mockManifests = {
      deploy: makeManifest(['deploy_run']),
      oncall: makeManifest(['oncall_page']),
    };

    const trackedIds = new Set<string>();

    // Activate both skills
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    projectSkillTools(history, { previouslyActiveSkillIds: trackedIds });
    expect(trackedIds.size).toBe(2);

    mockUnregisteredSkillIds = [];
    resetSkillToolProjection(trackedIds);

    expect(mockUnregisteredSkillIds).toContain('deploy');
    expect(mockUnregisteredSkillIds).toContain('oncall');
    expect(trackedIds.size).toBe(0);
  });

  test('no-op when called with undefined', () => {
    mockUnregisteredSkillIds = [];
    resetSkillToolProjection(undefined);
    expect(mockUnregisteredSkillIds).toHaveLength(0);
  });

  test('no-op when called with empty set', () => {
    mockUnregisteredSkillIds = [];
    resetSkillToolProjection(new Set());
    expect(mockUnregisteredSkillIds).toHaveLength(0);
  });
});
