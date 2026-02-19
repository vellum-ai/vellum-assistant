/**
 * Skill Projection Benchmark
 *
 * Measures projectSkillTools() latency across conversation sizes and caching scenarios.
 *
 * Baseline targets:
 * - Cold projection (100 msgs / 3 skills): < 50ms
 * - Cached projection (no change):         < 10ms
 * - Cold projection (1000 msgs / 5 skills): < 100ms
 * - Incremental scan (10 new msgs):         < 20ms
 */
import { describe, test, expect, mock } from 'bun:test';
import type { Message } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Mocks — must be registered before importing the module under test
// ---------------------------------------------------------------------------

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Skill catalog: returns a configurable list of fake skills
let catalogSkillIds: string[] = [];
mock.module('../config/skills.js', () => ({
  loadSkillCatalog: () =>
    catalogSkillIds.map((id) => ({
      id,
      name: id,
      description: `Mock skill ${id}`,
      directoryPath: `/tmp/fake-skills/${id}`,
      skillFilePath: `/tmp/fake-skills/${id}/SKILL.md`,
      bundled: false,
      userInvocable: false,
    })),
}));

mock.module('../skills/tool-manifest.js', () => ({
  parseToolManifestFile: (path: string) => {
    // Extract skill id from the path /tmp/fake-skills/<id>/TOOLS.json
    const parts = path.split('/');
    const skillId = parts[parts.length - 2];
    return {
      version: 1,
      tools: [
        {
          name: `${skillId}_tool_a`,
          description: `Tool A for ${skillId}`,
          input_schema: { type: 'object', properties: {} },
        },
        {
          name: `${skillId}_tool_b`,
          description: `Tool B for ${skillId}`,
          input_schema: { type: 'object', properties: {} },
        },
      ],
    };
  },
}));

mock.module('../skills/version-hash.js', () => ({
  computeSkillVersionHash: () => 'v1:deadbeef',
}));

// Mock createSkillToolsFromManifest to return lightweight Tool-like objects
mock.module('../tools/skills/skill-tool-factory.js', () => ({
  createSkillToolsFromManifest: (
    entries: Array<{ name: string; description: string; input_schema: object }>,
    skillId: string,
    _skillDir: string,
    versionHash: string,
    bundled?: boolean,
  ) =>
    entries.map((e) => ({
      name: e.name,
      description: e.description,
      category: 'skill',
      defaultRiskLevel: 'low',
      origin: 'skill' as const,
      ownerSkillId: skillId,
      ownerSkillVersionHash: versionHash,
      ownerSkillBundled: bundled,
      getDefinition: () => ({
        name: e.name,
        description: e.description,
        input_schema: e.input_schema,
      }),
      execute: async () => ({ content: '', isError: false }),
    })),
}));

// existsSync mock — TOOLS.json always exists for fake skills
mock.module('node:fs', () => ({
  existsSync: () => true,
}));

mock.module('../tools/registry.js', () => ({
  registerSkillTools: () => {},
  unregisterSkillTools: () => {},
  getTool: () => undefined,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { projectSkillTools } = await import('../daemon/session-skill-tools.js');
type SkillProjectionCache = import('../daemon/session-skill-tools.js').SkillProjectionCache;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic conversation history with interleaved user/assistant
 * messages and skill_load tool-use markers for the given skill IDs.
 *
 * Skill activations are spread evenly across the history.
 */
function buildHistory(messageCount: number, skillIds: string[]): Message[] {
  const msgs: Message[] = [];
  const activationInterval = Math.max(1, Math.floor(messageCount / skillIds.length));

  for (let i = 0; i < messageCount; i++) {
    // Every other message is user/assistant
    if (i % 2 === 0) {
      msgs.push({
        role: 'user',
        content: [
          { type: 'text', text: `User message ${i} about project tasks.` },
        ],
      });
    } else {
      const blocks: Message['content'] = [
        { type: 'text', text: `Assistant response ${i} with analysis.` },
      ];

      // Inject a skill_load tool_use at the activation point
      const skillIndex = Math.floor(i / activationInterval);
      if (skillIndex < skillIds.length) {
        const skillId = skillIds[skillIndex];
        const toolUseId = `tu-${skillId}-${i}`;
        blocks.push({
          type: 'tool_use',
          id: toolUseId,
          name: 'skill_load',
          input: { skill_id: skillId },
        });
      }

      msgs.push({ role: 'assistant', content: blocks });
    }
  }

  // Add matching tool_result messages for each skill_load tool_use
  for (const msg of [...msgs]) {
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.name === 'skill_load') {
        const skillId = (block.input as Record<string, string>).skill_id;
        msgs.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: block.id,
              content: `<loaded_skill id="${skillId}" version="v1:deadbeef" />`,
            },
          ],
        });
      }
    }
  }

  return msgs;
}

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe('Skill projection benchmark', () => {
  test('cold projection: 100 messages / 3 skills < 50ms', () => {
    const skillIds = ['skill-alpha', 'skill-beta', 'skill-gamma'];
    catalogSkillIds = skillIds;
    const history = buildHistory(100, skillIds);

    const elapsed = timeMs(() => {
      const result = projectSkillTools(history);
      expect(result.toolDefinitions.length).toBeGreaterThan(0);
      expect(result.allowedToolNames.size).toBeGreaterThan(0);
    });

    console.log(`  Cold projection (100 msgs / 3 skills): ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(50);
  });

  test('cached projection (no change) < 10ms', () => {
    const skillIds = ['skill-alpha', 'skill-beta', 'skill-gamma'];
    catalogSkillIds = skillIds;
    const history = buildHistory(100, skillIds);
    const cache: SkillProjectionCache = {};
    const prevActive = new Map<string, string>();

    // Warm the cache
    projectSkillTools(history, { cache, previouslyActiveSkillIds: prevActive });

    // Second call with identical history — should hit cache fast path
    const elapsed = timeMs(() => {
      const result = projectSkillTools(history, {
        cache,
        previouslyActiveSkillIds: prevActive,
      });
      expect(result.toolDefinitions.length).toBeGreaterThan(0);
    });

    console.log(`  Cached projection (no change): ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(10);
  });

  test('cold projection: 1000 messages / 5 skills < 100ms', () => {
    const skillIds = [
      'skill-alpha',
      'skill-beta',
      'skill-gamma',
      'skill-delta',
      'skill-epsilon',
    ];
    catalogSkillIds = skillIds;
    const history = buildHistory(1000, skillIds);

    const elapsed = timeMs(() => {
      const result = projectSkillTools(history);
      expect(result.toolDefinitions.length).toBeGreaterThan(0);
      expect(result.allowedToolNames.size).toBeGreaterThan(0);
    });

    console.log(`  Cold projection (1000 msgs / 5 skills): ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(100);
  });

  test('incremental scan (10 new messages appended) < 20ms', () => {
    const skillIds = ['skill-alpha', 'skill-beta', 'skill-gamma'];
    catalogSkillIds = skillIds;
    const history = buildHistory(100, skillIds);
    const cache: SkillProjectionCache = {};
    const prevActive = new Map<string, string>();

    // Warm the cache
    projectSkillTools(history, { cache, previouslyActiveSkillIds: prevActive });

    // Append 10 new plain messages (no new skill activations)
    for (let i = 0; i < 10; i++) {
      history.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `Follow-up message ${i}.` }],
      });
    }

    const elapsed = timeMs(() => {
      const result = projectSkillTools(history, {
        cache,
        previouslyActiveSkillIds: prevActive,
      });
      expect(result.toolDefinitions.length).toBeGreaterThan(0);
    });

    console.log(`  Incremental scan (10 new msgs): ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(20);
  });
});
