import { describe, test, expect } from 'bun:test';
import { RiskLevel } from '../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../tools/types.js';
import type { ToolDefinition } from '../providers/types.js';

// We cannot import the private LazyTool class directly, so we test through
// registerLazyTool + getTool which exercise the same code path.
import {
  registerTool,
  registerLazyTool,
  getTool,
  getAllTools,
  getAllToolDefinitions,
  initializeTools,
  registerSkillTools,
  unregisterSkillTools,
  getSkillToolNames,
  getSkillRefCount,
} from '../tools/registry.js';
import { eagerModules, explicitTools, lazyTools } from '../tools/tool-manifest.js';

function makeFakeTool(name: string): Tool {
  return {
    name,
    description: `Fake ${name}`,
    category: 'test',
    defaultRiskLevel: RiskLevel.Low,
    getDefinition(): ToolDefinition {
      return {
        name,
        description: `Fake ${name}`,
        input_schema: { type: 'object', properties: {}, required: [] },
      };
    },
    async execute(_input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
      return { content: 'ok', isError: false };
    },
  };
}

function makeSkillTool(name: string, ownerSkillId: string): Tool {
  return {
    ...makeFakeTool(name),
    origin: 'skill' as const,
    ownerSkillId,
  };
}

describe('LazyTool', () => {
  test('clears cached promise on load failure so subsequent call can retry', async () => {
    let callCount = 0;

    registerLazyTool({
      name: 'test-retry-tool',
      description: 'A tool that fails on first load then succeeds',
      category: 'test',
      defaultRiskLevel: RiskLevel.Low,
      definition: {
        name: 'test-retry-tool',
        description: 'A tool that fails on first load then succeeds',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      loader: async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('transient load failure');
        }
        return makeFakeTool('test-retry-tool');
      },
    });

    const tool = getTool('test-retry-tool')!;
    expect(tool).toBeDefined();

    const dummyContext = {} as ToolContext;

    // First call should throw the transient error
    await expect(tool.execute({}, dummyContext)).rejects.toThrow('transient load failure');
    expect(callCount).toBe(1);

    // Second call should retry the loader and succeed
    const result = await tool.execute({}, dummyContext);
    expect(result.content).toBe('ok');
    expect(result.isError).toBe(false);
    expect(callCount).toBe(2);
  });
});

describe('tool registry host tools', () => {
  test('registers host tools and exposes them in tool definitions', async () => {
    await initializeTools();

    const hostToolNames = ['host_file_read', 'host_file_write', 'host_file_edit', 'host_bash'] as const;

    for (const toolName of hostToolNames) {
      const tool = getTool(toolName);
      expect(tool).toBeDefined();
      expect(tool?.defaultRiskLevel).toBe(RiskLevel.Medium);
    }

    const definitionNames = getAllToolDefinitions().map((def) => def.name);
    for (const toolName of hostToolNames) {
      expect(definitionNames).toContain(toolName);
    }
  });
});

describe('tool registry dynamic-tools tools', () => {
  test('registers evaluate, scaffold, delete, and skill_load tools', async () => {
    await initializeTools();

    const dynamicToolNames = [
      'evaluate_typescript_code',
      'scaffold_managed_skill',
      'delete_managed_skill',
      'skill_load',
    ] as const;

    for (const toolName of dynamicToolNames) {
      const tool = getTool(toolName);
      expect(tool).toBeDefined();
    }

    const definitionNames = getAllToolDefinitions().map((def) => def.name);
    for (const toolName of dynamicToolNames) {
      expect(definitionNames).toContain(toolName);
    }
  });

  test('evaluate_typescript_code is registered as High risk', async () => {
    await initializeTools();
    const tool = getTool('evaluate_typescript_code');
    expect(tool).toBeDefined();
    expect(tool?.defaultRiskLevel).toBe(RiskLevel.High);
  });

  test('scaffold and delete are registered as High risk', async () => {
    await initializeTools();
    for (const name of ['scaffold_managed_skill', 'delete_managed_skill']) {
      const tool = getTool(name);
      expect(tool).toBeDefined();
      expect(tool?.defaultRiskLevel).toBe(RiskLevel.High);
    }
  });

  test('skill_load is registered as Low risk', async () => {
    await initializeTools();
    const tool = getTool('skill_load');
    expect(tool).toBeDefined();
    expect(tool?.defaultRiskLevel).toBe(RiskLevel.Low);
  });
});

describe('tool manifest', () => {
  test('all manifest lazy tools are registered after init', async () => {
    await initializeTools();
    const registered = new Set(getAllTools().map((t) => t.name));

    for (const descriptor of lazyTools) {
      expect(registered.has(descriptor.name)).toBe(true);
    }
  });

  test('manifest declares expected core lazy tools', () => {
    const lazyNames = new Set(lazyTools.map((t) => t.name));
    expect(lazyNames.has('bash')).toBe(true);
    expect(lazyNames.has('evaluate_typescript_code')).toBe(true);
    expect(lazyNames.has('claude_code')).toBe(false);
    expect(lazyNames.has('swarm_delegate')).toBe(true);
  });

  test('eager module list contains expected count', () => {
    expect(eagerModules.length).toBe(14);
  });

  test('explicit tools list includes memory, credential, and timer tools', () => {
    const names = explicitTools.map((t) => t.name);
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_save');
    expect(names).toContain('memory_update');
    expect(names).toContain('credential_store');
    expect(names).toContain('account_manage');
    expect(names).toContain('reminder');
  });

  test('registered tool count is at least eager + lazy + host', async () => {
    await initializeTools();
    const tools = getAllTools();
    expect(tools.length).toBeGreaterThanOrEqual(eagerModules.length + lazyTools.length);
  });
});

describe('baseline characterization: hardcoded tool loading', () => {
  test('gmail tools are NOT registered in the global registry after initializeTools()', async () => {
    await initializeTools();
    const allTools = getAllTools();
    const toolNames = allTools.map(t => t.name);

    const gmailTools = ['gmail_search', 'gmail_list_messages', 'gmail_get_message', 'gmail_mark_read',
      'gmail_draft', 'gmail_archive', 'gmail_batch_archive', 'gmail_label', 'gmail_batch_label',
      'gmail_trash', 'gmail_send', 'gmail_unsubscribe'];
    for (const name of gmailTools) {
      expect(toolNames).not.toContain(name);
    }
  });

  test('gmail eager module is NOT in eagerModules manifest', () => {
    expect(eagerModules).not.toContain('./gmail/executors.js');
  });

  test('weather tool is NOT in global registry after initializeTools()', async () => {
    await initializeTools();
    const tool = getTool('get_weather');
    expect(tool).toBeUndefined();
  });

  test('weather eager module is NOT in eagerModules manifest', () => {
    expect(eagerModules).not.toContain('./weather/get-weather.js');
  });

  test('claude_code is NOT in global registry after initializeTools()', async () => {
    await initializeTools();
    const tool = getTool('claude_code');
    expect(tool).toBeUndefined();
  });

  test('claude_code is NOT in lazyTools manifest', () => {
    const lazyNames = lazyTools.map(t => t.name);
    expect(lazyNames).not.toContain('claude_code');
  });
});

describe('tool origin metadata', () => {
  test('registers a skill-origin tool and preserves metadata via getTool()', () => {
    const skillTool: Tool = {
      ...makeFakeTool('test-skill-origin-tool'),
      origin: 'skill',
      ownerSkillId: 'test-skill',
    };

    registerTool(skillTool);

    const retrieved = getTool('test-skill-origin-tool');
    expect(retrieved).toBeDefined();
    expect(retrieved?.origin).toBe('skill');
    expect(retrieved?.ownerSkillId).toBe('test-skill');
  });

  test('core tools default to no origin metadata (undefined)', async () => {
    await initializeTools();

    const coreTool = getTool('host_file_read');
    expect(coreTool).toBeDefined();
    expect(coreTool?.origin).toBeUndefined();
    expect(coreTool?.ownerSkillId).toBeUndefined();
  });
});

describe('dynamic skill tool registry', () => {
  test('registers skill tools and retrieves them', () => {
    const tools = [
      makeSkillTool('sk_tool_a', 'my-skill'),
      makeSkillTool('sk_tool_b', 'my-skill'),
    ];
    registerSkillTools(tools);

    expect(getTool('sk_tool_a')).toBeDefined();
    expect(getTool('sk_tool_a')?.origin).toBe('skill');
    expect(getTool('sk_tool_a')?.ownerSkillId).toBe('my-skill');

    expect(getTool('sk_tool_b')).toBeDefined();
    expect(getTool('sk_tool_b')?.origin).toBe('skill');
  });

  test('rejects skill tool that collides with a core tool', async () => {
    await initializeTools();

    // host_file_read is a core tool registered during init
    const colliding = makeSkillTool('host_file_read', 'rogue-skill');
    expect(() => registerSkillTools([colliding])).toThrow(
      'collides with core tool',
    );
  });

  test('allows replacement within the same owning skill', () => {
    const original = makeSkillTool('sk_replaceable', 'owner-skill');
    registerSkillTools([original]);

    const replacement: Tool = {
      ...makeSkillTool('sk_replaceable', 'owner-skill'),
      description: 'Updated description',
    };
    // Should not throw
    registerSkillTools([replacement]);

    const retrieved = getTool('sk_replaceable');
    expect(retrieved?.description).toBe('Updated description');
  });

  test('rejects replacement from a different owning skill', () => {
    const original = makeSkillTool('sk_owned', 'skill-alpha');
    registerSkillTools([original]);

    const intruder = makeSkillTool('sk_owned', 'skill-beta');
    expect(() => registerSkillTools([intruder])).toThrow(
      'already registered by skill "skill-alpha"',
    );
  });

  test('unregisterSkillTools removes all tools for a skill', () => {
    const tools = [
      makeSkillTool('sk_rm_1', 'removable-skill'),
      makeSkillTool('sk_rm_2', 'removable-skill'),
    ];
    registerSkillTools(tools);
    expect(getTool('sk_rm_1')).toBeDefined();
    expect(getTool('sk_rm_2')).toBeDefined();

    unregisterSkillTools('removable-skill');

    expect(getTool('sk_rm_1')).toBeUndefined();
    expect(getTool('sk_rm_2')).toBeUndefined();
  });

  test('unregisterSkillTools does not affect tools from other skills', () => {
    registerSkillTools([makeSkillTool('sk_keep', 'keep-skill')]);
    registerSkillTools([makeSkillTool('sk_remove', 'nuke-skill')]);

    unregisterSkillTools('nuke-skill');

    expect(getTool('sk_keep')).toBeDefined();
    expect(getTool('sk_remove')).toBeUndefined();
  });

  test('getSkillToolNames returns only skill tool names', async () => {
    await initializeTools();

    registerSkillTools([
      makeSkillTool('sk_names_a', 'names-skill'),
      makeSkillTool('sk_names_b', 'names-skill'),
    ]);

    const skillNames = getSkillToolNames();
    expect(skillNames).toContain('sk_names_a');
    expect(skillNames).toContain('sk_names_b');
    // Core tools should not appear
    expect(skillNames).not.toContain('host_file_read');
    expect(skillNames).not.toContain('bash');
  });

  test('registerSkillTools is atomic — no partial registration on collision', async () => {
    await initializeTools();

    const tools = [
      makeSkillTool('sk_atomic_ok', 'atomic-skill'),
      makeSkillTool('host_file_read', 'atomic-skill'), // collides with core
    ];

    expect(() => registerSkillTools(tools)).toThrow('collides with core tool');
    // The first tool should NOT have been registered either
    expect(getTool('sk_atomic_ok')).toBeUndefined();
  });
});

describe('skill tool reference counting', () => {
  test('ref count increments on each registerSkillTools call', () => {
    registerSkillTools([makeSkillTool('rc_a', 'rc-skill')]);
    expect(getSkillRefCount('rc-skill')).toBe(1);

    // Second session registers the same skill (same ownerSkillId allows replacement)
    registerSkillTools([makeSkillTool('rc_a', 'rc-skill')]);
    expect(getSkillRefCount('rc-skill')).toBe(2);
  });

  test('unregister decrements ref count but keeps tools when count > 0', () => {
    registerSkillTools([makeSkillTool('rc_keep', 'rc-multi')]);
    registerSkillTools([makeSkillTool('rc_keep', 'rc-multi')]);
    expect(getSkillRefCount('rc-multi')).toBe(2);

    unregisterSkillTools('rc-multi');
    expect(getSkillRefCount('rc-multi')).toBe(1);
    // Tools still present
    expect(getTool('rc_keep')).toBeDefined();
  });

  test('tools are removed only when last reference is unregistered', () => {
    registerSkillTools([makeSkillTool('rc_last', 'rc-final')]);
    registerSkillTools([makeSkillTool('rc_last', 'rc-final')]);

    unregisterSkillTools('rc-final');
    expect(getTool('rc_last')).toBeDefined();

    unregisterSkillTools('rc-final');
    expect(getTool('rc_last')).toBeUndefined();
    expect(getSkillRefCount('rc-final')).toBe(0);
  });

  test('unregister with no prior registration is a no-op', () => {
    unregisterSkillTools('nonexistent-skill');
    expect(getSkillRefCount('nonexistent-skill')).toBe(0);
  });
});
