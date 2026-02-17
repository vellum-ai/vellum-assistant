import { describe, test, expect, beforeEach, mock } from 'bun:test';
import * as realFs from 'node:fs';
import type { Message } from '../providers/types.js';
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
    // Replicate the real regex scan for loaded_skill markers
    const re = /<loaded_skill\s+id="([^"]+)"\s*\/>/g;
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const msg of messages) {
      for (const block of msg.content) {
        let text: string | undefined;
        if (block.type === 'text') text = block.text;
        else if (block.type === 'tool_result') text = block.content;
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

function toolResultMsg(content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('projectSkillTools', () => {
  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    resetSkillToolProjection();
  });

  test('no active skills returns empty projection', () => {
    const result = projectSkillTools([]);

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames.size).toBe(0);
  });

  test('active skill with valid manifest returns tool definitions', () => {
    mockCatalog = [makeSkill('deploy')];
    mockManifests = { deploy: makeManifest(['deploy_run', 'deploy_status']) };

    const history: Message[] = [
      toolResultMsg('<loaded_skill id="deploy" />'),
    ];

    const result = projectSkillTools(history);

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
      toolResultMsg('<loaded_skill id="deploy" />'),
      toolResultMsg('<loaded_skill id="oncall" />'),
    ];

    const result = projectSkillTools(history);

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
      toolResultMsg('<loaded_skill id="deploy" />'),
    ];

    const result = projectSkillTools(history, {
      preactivatedSkillIds: ['oncall'],
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
      toolResultMsg('<loaded_skill id="deploy" />'),
      toolResultMsg('<loaded_skill id="oncall" />'),
    ];
    projectSkillTools(history1);

    // Second turn: only deploy remains active (oncall marker gone)
    mockUnregisteredSkillIds = [];
    const history2: Message[] = [
      toolResultMsg('<loaded_skill id="deploy" />'),
    ];
    const result = projectSkillTools(history2);

    expect(mockUnregisteredSkillIds).toContain('oncall');
    expect(result.allowedToolNames).toEqual(new Set(['deploy_run']));
  });

  test('invalid/missing manifest is gracefully handled', () => {
    mockCatalog = [makeSkill('broken')];
    // No manifest registered for "broken", so parseToolManifestFile will throw

    const history: Message[] = [
      toolResultMsg('<loaded_skill id="broken" />'),
    ];

    const result = projectSkillTools(history);

    // Should not throw, just return empty projection for that skill
    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames.size).toBe(0);
  });

  test('skill ID not in catalog is gracefully skipped', () => {
    mockCatalog = []; // empty catalog
    mockManifests = {};

    const history: Message[] = [
      toolResultMsg('<loaded_skill id="nonexistent" />'),
    ];

    const result = projectSkillTools(history);

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames.size).toBe(0);
  });

  test('preactivated IDs merge with context-derived IDs (dedup)', () => {
    mockCatalog = [makeSkill('deploy')];
    mockManifests = { deploy: makeManifest(['deploy_run']) };

    const history: Message[] = [
      toolResultMsg('<loaded_skill id="deploy" />'),
    ];

    // deploy is both in history AND preactivated — should not duplicate
    const result = projectSkillTools(history, {
      preactivatedSkillIds: ['deploy'],
    });

    expect(result.toolDefinitions).toHaveLength(1);
    expect(result.allowedToolNames).toEqual(new Set(['deploy_run']));
  });

  test('no markers in history with preactivated IDs still projects tools', () => {
    mockCatalog = [makeSkill('oncall')];
    mockManifests = { oncall: makeManifest(['oncall_page']) };

    const result = projectSkillTools([], {
      preactivatedSkillIds: ['oncall'],
    });

    expect(result.toolDefinitions).toHaveLength(1);
    expect(result.allowedToolNames).toEqual(new Set(['oncall_page']));
  });
});
