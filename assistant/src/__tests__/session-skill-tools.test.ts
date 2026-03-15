import * as realFs from "node:fs";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillSummary, SkillToolManifest } from "../config/skills.js";
import { RiskLevel } from "../permissions/types.js";
import type {
  Message,
  ToolDefinition,
  ToolResultContent,
  ToolUseContent,
} from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import {
  assertBrowserToolsAbsent,
  assertBrowserToolsPresent,
  BROWSER_TOOL_NAMES,
  buildSkillLoadHistory,
} from "./test-support/browser-skill-harness.js";

// ---------------------------------------------------------------------------
// Mock state — controlled by tests
// ---------------------------------------------------------------------------

let mockCatalog: SkillSummary[] = [];
let mockManifests: Record<string, SkillToolManifest | null> = {};
let mockRegisteredTools: Map<string, Tool[]> = new Map();
let mockUnregisteredSkillIds: string[] = [];
let mockSkillRefCount: Map<string, number> = new Map();
/** Per-skill version hash overrides. When set, computeSkillVersionHash returns this value. */
let mockVersionHashes: Record<string, string> = {};
/** Skill IDs for which computeSkillVersionHash should throw (simulates unreadable directories). */
let mockVersionHashErrors: Set<string> = new Set();

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => mockCatalog,
}));

mock.module("../skills/active-skill-tools.js", () => {
  // Shared parsing logic for deriveActiveSkills
  const parseMarkers = (messages: Message[]) => {
    // Two-pass approach matching real implementation:
    // 1. Collect tool_use IDs where name === 'skill_load'
    const skillLoadUseIds = new Set<string>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.name === "skill_load") {
          skillLoadUseIds.add(block.id);
        }
      }
    }

    // 2. Parse markers only from tool_result blocks whose tool_use_id matches
    const re = /<loaded_skill\s+id="([^"]+)"(?:\s+version="([^"]+)")?\s*\/>/g;
    const seen = new Set<string>();
    const entries: Array<{ id: string; version?: string }> = [];
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type !== "tool_result") continue;
        if (!skillLoadUseIds.has(block.tool_use_id)) continue;
        const text = block.content;
        if (!text) continue;
        for (const match of text.matchAll(re)) {
          if (!seen.has(match[1])) {
            seen.add(match[1]);
            const entry: { id: string; version?: string } = { id: match[1] };
            if (match[2]) {
              entry.version = match[2];
            }
            entries.push(entry);
          }
        }
      }
    }
    return entries;
  };

  return {
    deriveActiveSkills: (messages: Message[]) => parseMarkers(messages),
  };
});

mock.module("../skills/tool-manifest.js", () => ({
  parseToolManifestFile: (filePath: string) => {
    // Extract skill ID from path: /skills/<id>/TOOLS.json → <id>
    const parts = filePath.split("/");
    const skillId = parts[parts.length - 2];
    const manifest = mockManifests[skillId];
    if (!manifest) {
      throw new Error(`Mock: no manifest for skill "${skillId}"`);
    }
    return manifest;
  },
}));

mock.module("../tools/skills/skill-tool-factory.js", () => ({
  createSkillToolsFromManifest: (
    entries: SkillToolManifest["tools"],
    skillId: string,
    _skillDir: string,
    versionHash: string,
    bundled?: boolean,
  ): Tool[] => {
    return entries.map((entry) => ({
      name: entry.name,
      description: entry.description,
      category: entry.category,
      defaultRiskLevel: RiskLevel.Medium,
      origin: "skill" as const,
      ownerSkillId: skillId,
      ownerSkillVersionHash: versionHash,
      ownerSkillBundled: bundled ?? undefined,
      getDefinition: () => ({
        name: entry.name,
        description: entry.description,
        input_schema: entry.input_schema as object,
      }),
      execute: async () => ({ content: "", isError: false }),
    }));
  },
}));

mock.module("../tools/registry.js", () => ({
  registerSkillTools: (tools: Tool[]) => {
    const skillIds = new Set<string>();
    for (const tool of tools) {
      const skillId = tool.ownerSkillId!;
      skillIds.add(skillId);
      const existing = mockRegisteredTools.get(skillId) ?? [];
      existing.push(tool);
      mockRegisteredTools.set(skillId, existing);
    }
    for (const id of skillIds) {
      mockSkillRefCount.set(id, (mockSkillRefCount.get(id) ?? 0) + 1);
    }
    return tools;
  },
  unregisterSkillTools: (skillId: string) => {
    mockUnregisteredSkillIds.push(skillId);
    const current = mockSkillRefCount.get(skillId) ?? 0;
    if (current > 1) {
      mockSkillRefCount.set(skillId, current - 1);
      return;
    }
    mockSkillRefCount.delete(skillId);
    mockRegisteredTools.delete(skillId);
  },
  getTool: (name: string): Tool | undefined => {
    // Return the last matching tool to match production behavior where
    // re-registering a tool overwrites the previous entry (last wins).
    let found: Tool | undefined;
    for (const tools of mockRegisteredTools.values()) {
      for (const tool of tools) {
        if (tool.name === name) found = tool;
      }
    }
    return found;
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
mock.module("node:fs", () => ({
  ...realFs,
  existsSync: (p: string) => {
    if (typeof p === "string" && p.endsWith("TOOLS.json")) {
      const parts = p.split("/");
      const skillId = parts[parts.length - 2];
      return skillId in mockManifests;
    }
    return realFs.existsSync(p);
  },
}));

mock.module("../skills/version-hash.js", () => ({
  computeSkillVersionHash: (skillDir: string) => {
    const parts = skillDir.split("/");
    const skillId = parts[parts.length - 1];
    if (mockVersionHashErrors.has(skillId)) {
      throw new Error(`EACCES: permission denied, scandir '${skillDir}'`);
    }
    if (skillId in mockVersionHashes) {
      return mockVersionHashes[skillId];
    }
    return `v1:default-hash-${skillId}`;
  },
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    skills: { entries: {}, allowBundled: null },
    assistantFeatureFlagValues: {},
  }),
  loadConfig: () => ({
    skills: { entries: {}, allowBundled: null },
    assistantFeatureFlagValues: {},
  }),
  invalidateConfigCache: () => {},
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
  loadDefaultsRegistry: () => ({}),
}));

mock.module("../config/skill-state.js", () => ({
  skillFlagKey: (skill: { featureFlag?: string }) =>
    skill.featureFlag
      ? `feature_flags.${skill.featureFlag}.enabled`
      : undefined,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { projectSkillTools, resetSkillToolProjection } =
  await import("../daemon/session-skill-tools.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(id: string, dir?: string): SkillSummary {
  return {
    id,
    name: id,
    displayName: id,
    description: `Skill ${id}`,
    directoryPath: dir ?? `/skills/${id}`,
    skillFilePath: `/skills/${id}/SKILL.md`,

    source: "managed",
  };
}

function makeManifest(toolNames: string[]): SkillToolManifest {
  return {
    version: 1,
    tools: toolNames.map((name) => ({
      name,
      description: `Tool ${name}`,
      category: "test",
      risk: "medium" as const,
      input_schema: { type: "object", properties: {} },
      executor: "run.ts",
      execution_target: "host" as const,
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
      role: "assistant",
      content: [{ type: "tool_use", id, name: "skill_load", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterAll(() => {
  mock.restore();
});

describe("projectSkillTools", () => {
  let sessionState: Map<string, string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("no active skills returns empty projection", () => {
    const result = projectSkillTools([], {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames.size).toBe(0);
  });

  test("active skill with valid manifest returns empty tool definitions but populates allowedToolNames", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run", "deploy_status"]) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    // Tool definitions are no longer sent to the LLM — tools are invoked via skill_execute dispatch.
    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(
      new Set(["deploy_run", "deploy_status"]),
    );
  });

  test("multiple active skills are projected", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
    };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(
      new Set(["deploy_run", "oncall_page"]),
    );
  });

  test("preactivated skill IDs are included", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
    };

    // Only deploy is in history; oncall is preactivated
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    const result = projectSkillTools(history, {
      preactivatedSkillIds: ["oncall"],
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(
      new Set(["deploy_run", "oncall_page"]),
    );
  });

  test("skill deactivation: previously active skill is unregistered when removed from history", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
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
    const result = projectSkillTools(history2, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(mockUnregisteredSkillIds).toContain("oncall");
    expect(result.allowedToolNames).toEqual(new Set(["deploy_run"]));
  });

  test("invalid/missing manifest is gracefully handled", () => {
    mockCatalog = [makeSkill("broken")];
    // No manifest registered for "broken", so parseToolManifestFile will throw

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="broken" />'),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    // Should not throw, just return empty projection for that skill
    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames.size).toBe(0);
  });

  test("skill ID not in catalog is gracefully skipped", () => {
    mockCatalog = []; // empty catalog
    mockManifests = {};

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="nonexistent" />'),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames.size).toBe(0);
  });

  test("skill with catalog miss on turn 1 is registered when catalog is populated on turn 2", () => {
    // Turn 1: skill is active but NOT in the catalog — should not be tracked
    mockCatalog = []; // empty catalog
    mockManifests = {};

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    const result1 = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    expect(result1.toolDefinitions).toEqual([]);
    expect(sessionState.has("deploy")).toBe(false);

    // Turn 2: catalog now has the skill — should register successfully
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };

    const result2 = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    expect(result2.toolDefinitions).toEqual([]);
    expect(result2.allowedToolNames.has("deploy_run")).toBe(true);
    expect(sessionState.has("deploy")).toBe(true);

    // Verify registerSkillTools was called (tool is in the registry)
    expect(mockRegisteredTools.has("deploy")).toBe(true);
  });

  test("skill with manifest failure on turn 1 is registered when manifest is available on turn 2", () => {
    mockCatalog = [makeSkill("deploy")];
    // No manifest — will fail to load
    mockManifests = {};

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    const result1 = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    expect(result1.toolDefinitions).toEqual([]);
    expect(sessionState.has("deploy")).toBe(false);

    // Turn 2: manifest now available
    mockManifests = { deploy: makeManifest(["deploy_run"]) };

    const result2 = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    expect(result2.toolDefinitions).toEqual([]);
    expect(result2.allowedToolNames.has("deploy_run")).toBe(true);
    expect(sessionState.has("deploy")).toBe(true);
    expect(mockRegisteredTools.has("deploy")).toBe(true);
  });

  test("previously-registered skill that transiently fails is unregistered to prevent refcount leak", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // Turn 1: skill registered successfully
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    expect(sessionState.has("deploy")).toBe(true);
    expect(mockSkillRefCount.get("deploy")).toBe(1);

    // Turn 2: manifest transiently fails — skill should be unregistered
    mockManifests = {};
    mockUnregisteredSkillIds = [];
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    expect(sessionState.has("deploy")).toBe(false);
    expect(mockUnregisteredSkillIds).toContain("deploy");
    // Ref count should be 0 (properly decremented)
    expect(mockSkillRefCount.has("deploy")).toBe(false);

    // Turn 3: manifest recovers — skill re-registered with correct ref count
    mockManifests = { deploy: makeManifest(["deploy_run"]) };
    mockUnregisteredSkillIds = [];
    const result3 = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    expect(result3.toolDefinitions).toEqual([]);
    expect(result3.allowedToolNames.has("deploy_run")).toBe(true);
    expect(sessionState.has("deploy")).toBe(true);
    // Ref count should be exactly 1, not 2
    expect(mockSkillRefCount.get("deploy")).toBe(1);
  });

  test("skill version hash change triggers unregister and re-register", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };
    mockVersionHashes = { deploy: "v1:hash-aaa" };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // Turn 1: skill registered with hash-aaa
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    expect(sessionState.has("deploy")).toBe(true);
    expect(sessionState.get("deploy")).toBe("v1:hash-aaa");
    expect(mockSkillRefCount.get("deploy")).toBe(1);

    // Turn 2: hash changes — should unregister old and re-register new
    mockVersionHashes = { deploy: "v1:hash-bbb" };
    mockUnregisteredSkillIds = [];
    const result2 = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    expect(result2.toolDefinitions).toEqual([]);
    expect(result2.allowedToolNames.has("deploy_run")).toBe(true);
    expect(sessionState.get("deploy")).toBe("v1:hash-bbb");
    // Unregister was called for the stale version
    expect(mockUnregisteredSkillIds).toContain("deploy");
    // Ref count should remain 1 (unregister decremented, re-register incremented)
    expect(mockSkillRefCount.get("deploy")).toBe(1);
  });

  test("skill version hash unchanged skips re-registration", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };
    mockVersionHashes = { deploy: "v1:stable-hash" };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // Turn 1: skill registered
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    expect(mockSkillRefCount.get("deploy")).toBe(1);

    // Turn 2: same hash — should NOT call registerSkillTools again
    mockUnregisteredSkillIds = [];
    const result2 = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    expect(result2.toolDefinitions).toEqual([]);
    expect(result2.allowedToolNames.has("deploy_run")).toBe(true);
    expect(mockUnregisteredSkillIds).not.toContain("deploy");
    // Ref count should still be 1 (no additional registration)
    expect(mockSkillRefCount.get("deploy")).toBe(1);
  });

  test("preactivated IDs merge with context-derived IDs (dedup)", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // deploy is both in history AND preactivated — should not duplicate
    const result = projectSkillTools(history, {
      preactivatedSkillIds: ["deploy"],
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(new Set(["deploy_run"]));
  });

  test("no markers in history with preactivated IDs still projects tools", () => {
    mockCatalog = [makeSkill("oncall")];
    mockManifests = { oncall: makeManifest(["oncall_page"]) };

    const result = projectSkillTools([], {
      preactivatedSkillIds: ["oncall"],
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(new Set(["oncall_page"]));
  });

  test("concurrent sessions do not interfere with each other", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
    };

    const sessionA = new Map<string, string>();
    const sessionB = new Map<string, string>();

    // Session A activates deploy
    const historyA: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];
    const resultA = projectSkillTools(historyA, {
      previouslyActiveSkillIds: sessionA,
    });
    expect(resultA.allowedToolNames.has("deploy_run")).toBe(true);

    // Session B activates oncall — should NOT unregister deploy from session A
    mockUnregisteredSkillIds = [];
    const historyB: Message[] = [
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    projectSkillTools(historyB, { previouslyActiveSkillIds: sessionB });
    expect(mockUnregisteredSkillIds).not.toContain("deploy");

    // Session A's state should still track deploy
    expect(sessionA.has("deploy")).toBe(true);
    expect(sessionB.has("oncall")).toBe(true);
  });

  test("disposing session A while session B uses the same skill does NOT remove tools", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };

    const sessionA = new Map<string, string>();
    const sessionB = new Map<string, string>();

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // Both sessions activate deploy
    projectSkillTools(history, { previouslyActiveSkillIds: sessionA });
    projectSkillTools(history, { previouslyActiveSkillIds: sessionB });

    // Ref count should be 2
    expect(mockSkillRefCount.get("deploy")).toBe(2);

    // Session A tears down
    resetSkillToolProjection(sessionA);

    // Tools should still be registered (ref count decremented but > 0)
    expect(mockRegisteredTools.has("deploy")).toBe(true);
    expect(mockSkillRefCount.get("deploy")).toBe(1);

    // Session B can still project the skill tools
    const resultB = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionB,
    });
    expect(resultB.allowedToolNames.has("deploy_run")).toBe(true);
  });

  test("tools ARE removed when the last session using them disposes", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };

    const sessionA = new Map<string, string>();
    const sessionB = new Map<string, string>();

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // Both sessions activate deploy
    projectSkillTools(history, { previouslyActiveSkillIds: sessionA });
    projectSkillTools(history, { previouslyActiveSkillIds: sessionB });

    // Both sessions tear down
    resetSkillToolProjection(sessionA);
    expect(mockRegisteredTools.has("deploy")).toBe(true);

    resetSkillToolProjection(sessionB);
    expect(mockRegisteredTools.has("deploy")).toBe(false);
    expect(mockSkillRefCount.has("deploy")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveTools callback integration tests
// ---------------------------------------------------------------------------

describe("resolveTools callback (session wiring)", () => {
  // Simulates the resolveTools callback wired in the Session constructor.
  // Since skill tool definitions are no longer sent to the LLM (tools are
  // invoked via skill_execute dispatch), the definitions array only contains
  // base (core + MCP) tools. Skill tool names still appear in allowedToolNames.
  const baseToolDefs: ToolDefinition[] = [
    {
      name: "file_read",
      description: "Read a file",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "bash",
      description: "Run a shell command",
      input_schema: { type: "object", properties: {} },
    },
  ];

  let sessionState: Map<string, string>;

  function makeResolveTools(base: ToolDefinition[]) {
    return (history: Message[]): ToolDefinition[] => {
      const projection = projectSkillTools(history, {
        previouslyActiveSkillIds: sessionState,
      });
      // projection.toolDefinitions is now always [] — skill tools are dispatched via skill_execute
      return [...base, ...projection.toolDefinitions];
    };
  }

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("returns only base tools when no skills are active", () => {
    const resolveTools = makeResolveTools(baseToolDefs);
    const result = resolveTools([]);

    expect(result).toHaveLength(2);
    expect(result.map((d) => d.name)).toEqual(["file_read", "bash"]);
  });

  test("skill tools are NOT appended to definitions — only base tools returned", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run", "deploy_status"]) };

    const resolveTools = makeResolveTools(baseToolDefs);
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    const result = resolveTools(history);

    // Only base tools — skill tool definitions no longer sent to LLM
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.name)).toEqual(["file_read", "bash"]);
  });

  test("base tools are unchanged even when skills are active", () => {
    mockCatalog = [makeSkill("oncall")];
    mockManifests = { oncall: makeManifest(["oncall_page"]) };

    const resolveTools = makeResolveTools(baseToolDefs);
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];

    const result = resolveTools(history);

    // Only base tools present
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("file_read");
    expect(result[1].name).toBe("bash");
  });

  test("multiple active skills do not add tools to definitions array", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page", "oncall_ack"]),
    };

    const resolveTools = makeResolveTools(baseToolDefs);
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];

    const result = resolveTools(history);

    // Only base tools — skill tool definitions no longer in the API tools array
    expect(result).toHaveLength(2);
    const names = result.map((d) => d.name);
    expect(names).toContain("file_read");
    expect(names).toContain("bash");
    expect(names).not.toContain("deploy_run");
    expect(names).not.toContain("oncall_page");
    expect(names).not.toContain("oncall_ack");
  });
});

// ---------------------------------------------------------------------------
// Tests — allowed tool set merging with core tools
// ---------------------------------------------------------------------------

describe("allowed tool set merging", () => {
  const CORE_TOOL_NAMES = new Set([
    "bash",
    "file_read",
    "file_write",
    "file_edit",
  ]);
  let sessionState: Map<string, string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  /**
   * Simulates the merging logic from session.ts:
   * union of core tool names + projected skill tool names.
   */
  function buildAllowedSet(projection: {
    allowedToolNames: Set<string>;
  }): Set<string> {
    const merged = new Set(CORE_TOOL_NAMES);
    for (const name of projection.allowedToolNames) {
      merged.add(name);
    }
    return merged;
  }

  test("core tools are always included even with no active skills", () => {
    const projection = projectSkillTools([], {
      previouslyActiveSkillIds: sessionState,
    });
    const allowed = buildAllowedSet(projection);

    for (const core of CORE_TOOL_NAMES) {
      expect(allowed.has(core)).toBe(true);
    }
  });

  test("active skill tools are included alongside core tools", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run", "deploy_status"]) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    const projection = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    const allowed = buildAllowedSet(projection);

    // Core tools present
    for (const core of CORE_TOOL_NAMES) {
      expect(allowed.has(core)).toBe(true);
    }
    // Active skill tools present
    expect(allowed.has("deploy_run")).toBe(true);
    expect(allowed.has("deploy_status")).toBe(true);
  });

  test("inactive skill tools are NOT in the allowed set", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
    };

    // Only deploy is active
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    const projection = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    const allowed = buildAllowedSet(projection);

    expect(allowed.has("deploy_run")).toBe(true);
    // oncall_page is not active — not in projection, not in allowed set
    expect(allowed.has("oncall_page")).toBe(false);
  });

  test("allowed set updates when skills activate and deactivate", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
    };

    // Turn 1: both active
    const history1: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    const projection1 = projectSkillTools(history1, {
      previouslyActiveSkillIds: sessionState,
    });
    const allowed1 = buildAllowedSet(projection1);

    expect(allowed1.has("deploy_run")).toBe(true);
    expect(allowed1.has("oncall_page")).toBe(true);

    // Turn 2: only deploy remains
    const history2: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];
    const projection2 = projectSkillTools(history2, {
      previouslyActiveSkillIds: sessionState,
    });
    const allowed2 = buildAllowedSet(projection2);

    expect(allowed2.has("deploy_run")).toBe(true);
    expect(allowed2.has("oncall_page")).toBe(false);
    // Core tools still present
    for (const core of CORE_TOOL_NAMES) {
      expect(allowed2.has(core)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end mid-run activation tests
// ---------------------------------------------------------------------------

// ── Security invariant (PR 34): skill_load is the permission gate ──
// In strict mode, skill_load requires an explicit trust rule before the
// tool executor emits a <loaded_skill> marker. Without that marker in
// the conversation history, projectSkillTools will never activate the
// skill's tools. The permission enforcement lives in checker.ts; the
// tests here verify that tool activation only occurs when markers are
// present — meaning the permission check already succeeded.

describe("skill activation requires loaded_skill marker (security invariant)", () => {
  let sessionState: Map<string, string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("skill_load tool_use without tool_result marker does not activate skill tools", () => {
    mockCatalog = [makeSkill("gated")];
    mockManifests = { gated: makeManifest(["gated_action"]) };

    // History has a skill_load call but NO tool_result with a
    // <loaded_skill> marker — simulating a permission denial or pending
    // prompt in strict mode where the tool never executed.
    const history: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "sl-gate-1",
            name: "skill_load",
            input: { skill_id: "gated" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "sl-gate-1",
            content: "Permission denied.",
          },
        ],
      },
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    expect(result.toolDefinitions).toHaveLength(0);
    expect(result.allowedToolNames.size).toBe(0);
  });

  test("skill_load with valid marker activates skill tools (approved path)", () => {
    mockCatalog = [makeSkill("approved")];
    mockManifests = { approved: makeManifest(["approved_action"]) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="approved" />'),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames.has("approved_action")).toBe(true);
  });
});

describe("mid-run skill tool activation (end-to-end)", () => {
  const baseToolDefs: ToolDefinition[] = [
    {
      name: "file_read",
      description: "Read a file",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "bash",
      description: "Run a shell command",
      input_schema: { type: "object", properties: {} },
    },
  ];

  const CORE_TOOL_NAMES = new Set([
    "bash",
    "file_read",
    "file_write",
    "file_edit",
  ]);
  let sessionState: Map<string, string>;

  function makeResolveTools(base: ToolDefinition[]) {
    return (history: Message[]) => {
      const projection = projectSkillTools(history, {
        previouslyActiveSkillIds: sessionState,
      });
      return {
        toolDefinitions: [...base, ...projection.toolDefinitions],
        allowedToolNames: new Set([
          ...CORE_TOOL_NAMES,
          ...projection.allowedToolNames,
        ]),
      };
    };
  }

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("Turn 1 calls skill_load → Turn 2 skill is in allowedToolNames but NOT in tool definitions", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };

    const resolveTools = makeResolveTools(baseToolDefs);

    // Turn 1: no skill markers in history yet
    const historyTurn1: Message[] = [
      { role: "user", content: [{ type: "text", text: "Please deploy" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Let me load the deploy skill." }],
      },
    ];

    const turn1Result = resolveTools(historyTurn1);
    expect(turn1Result.toolDefinitions.map((d) => d.name)).toEqual([
      "file_read",
      "bash",
    ]);
    expect(turn1Result.allowedToolNames.has("deploy_run")).toBe(false);

    // Simulate skill_load output appended as a tool result in the same run
    const historyTurn2: Message[] = [
      ...historyTurn1,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "skill-load-1",
            name: "skill_load",
            input: { skill_id: "deploy" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "skill-load-1",
            content: '<loaded_skill id="deploy" />',
          },
        ],
      },
    ];

    const turn2Result = resolveTools(historyTurn2);
    // Tool definitions remain stable (only base tools) — skill tools dispatched via skill_execute
    expect(turn2Result.toolDefinitions.map((d) => d.name)).toEqual([
      "file_read",
      "bash",
    ]);
    expect(turn2Result.allowedToolNames.has("deploy_run")).toBe(true);
  });

  test("activation succeeds without requiring a new user message", () => {
    mockCatalog = [makeSkill("monitor")];
    mockManifests = {
      monitor: makeManifest(["monitor_check", "monitor_alert"]),
    };

    const resolveTools = makeResolveTools(baseToolDefs);

    // History contains only the initial user message and the assistant's
    // tool_use that triggered skill_load, followed by the tool result.
    // No second user message is present — the agent loop re-projects
    // tools between turns within the same run.
    const history: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Monitor the service" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "skill_load",
            input: { skill_id: "monitor" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-1",
            content: '<loaded_skill id="monitor" />',
          },
        ],
      },
    ];

    const result = resolveTools(history);

    // Skill tools are NOT in the definitions array — dispatched via skill_execute
    expect(result.toolDefinitions.map((d) => d.name)).not.toContain(
      "monitor_check",
    );
    expect(result.toolDefinitions.map((d) => d.name)).not.toContain(
      "monitor_alert",
    );
    // But they ARE in the allowed set (for skill_execute dispatch)
    expect(result.allowedToolNames.has("monitor_check")).toBe(true);
    expect(result.allowedToolNames.has("monitor_alert")).toBe(true);

    // Core tools remain accessible
    for (const core of CORE_TOOL_NAMES) {
      expect(result.allowedToolNames.has(core)).toBe(true);
    }
  });

  test("multiple skills can activate in sequence across turns", () => {
    mockCatalog = [
      makeSkill("deploy"),
      makeSkill("oncall"),
      makeSkill("metrics"),
    ];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
      metrics: makeManifest(["metrics_query", "metrics_dashboard"]),
    };

    const resolveTools = makeResolveTools(baseToolDefs);

    // Step 1: Load skill A (deploy)
    const historyAfterA: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "I need to deploy and check oncall" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "skill_load",
            input: { skill_id: "deploy" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-1",
            content: '<loaded_skill id="deploy" />',
          },
        ],
      },
    ];

    const resultA = resolveTools(historyAfterA);
    const namesA = resultA.toolDefinitions.map((d) => d.name);
    // Skill tools not in definitions — only in allowedToolNames
    expect(namesA).not.toContain("deploy_run");
    expect(namesA).not.toContain("oncall_page");
    expect(namesA).not.toContain("metrics_query");
    expect(resultA.allowedToolNames.has("deploy_run")).toBe(true);

    // Step 2: Load skill B (oncall) — deploy should remain active
    const historyAfterB: Message[] = [
      ...historyAfterA,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-2",
            name: "skill_load",
            input: { skill_id: "oncall" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-2",
            content: '<loaded_skill id="oncall" />',
          },
        ],
      },
    ];

    const resultB = resolveTools(historyAfterB);
    const namesB = resultB.toolDefinitions.map((d) => d.name);
    // Skill tools not in definitions
    expect(namesB).not.toContain("deploy_run");
    expect(namesB).not.toContain("oncall_page");
    expect(namesB).not.toContain("metrics_query");
    expect(resultB.allowedToolNames.has("deploy_run")).toBe(true);
    expect(resultB.allowedToolNames.has("oncall_page")).toBe(true);

    // Step 3: Load skill C (metrics) — all three should be active
    const historyAfterC: Message[] = [
      ...historyAfterB,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-3",
            name: "skill_load",
            input: { skill_id: "metrics" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-3",
            content: '<loaded_skill id="metrics" />',
          },
        ],
      },
    ];

    const resultC = resolveTools(historyAfterC);
    const namesC = resultC.toolDefinitions.map((d) => d.name);
    // Skill tools not in definitions — only base tools
    expect(namesC).not.toContain("deploy_run");
    expect(namesC).not.toContain("oncall_page");
    expect(namesC).not.toContain("metrics_query");
    expect(namesC).not.toContain("metrics_dashboard");
    expect(namesC).toEqual(["file_read", "bash"]);

    // Verify allowed tool names include all skill tools plus core tools
    expect(resultC.allowedToolNames.has("deploy_run")).toBe(true);
    expect(resultC.allowedToolNames.has("oncall_page")).toBe(true);
    expect(resultC.allowedToolNames.has("metrics_query")).toBe(true);
    expect(resultC.allowedToolNames.has("metrics_dashboard")).toBe(true);
    for (const core of CORE_TOOL_NAMES) {
      expect(resultC.allowedToolNames.has(core)).toBe(true);
    }
  });
});

// Context-derived deactivation regression tests
// ---------------------------------------------------------------------------

describe("context-derived deactivation regression", () => {
  const baseToolDefs: ToolDefinition[] = [
    {
      name: "file_read",
      description: "Read a file",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "bash",
      description: "Run a shell command",
      input_schema: { type: "object", properties: {} },
    },
  ];

  const CORE_TOOL_NAMES = new Set([
    "bash",
    "file_read",
    "file_write",
    "file_edit",
  ]);
  let sessionState: Map<string, string>;

  function makeResolveTools(base: ToolDefinition[]) {
    return (history: Message[]) => {
      const projection = projectSkillTools(history, {
        previouslyActiveSkillIds: sessionState,
      });
      return {
        toolDefinitions: [...base, ...projection.toolDefinitions],
        allowedToolNames: new Set([
          ...CORE_TOOL_NAMES,
          ...projection.allowedToolNames,
        ]),
      };
    };
  }

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("tool definitions stay stable — only allowedToolNames changes when skills deactivate", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page", "oncall_ack"]),
    };

    const resolveTools = makeResolveTools(baseToolDefs);

    // Turn 1: both skills active
    const history1: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    const result1 = resolveTools(history1);
    // Only base tools in definitions — skill tools dispatched via skill_execute
    expect(result1.toolDefinitions).toHaveLength(2);
    expect(result1.allowedToolNames.has("oncall_page")).toBe(true);
    expect(result1.allowedToolNames.has("oncall_ack")).toBe(true);

    // Turn 2: oncall marker removed from history (truncated)
    const history2: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];
    const result2 = resolveTools(history2);

    // Tool definitions unchanged — still only base tools
    expect(result2.toolDefinitions).toHaveLength(2);
    expect(result2.toolDefinitions.map((d) => d.name)).toEqual([
      "file_read",
      "bash",
    ]);
    // allowedToolNames reflects deactivation
    expect(result2.allowedToolNames.has("deploy_run")).toBe(true);
    expect(result2.allowedToolNames.has("oncall_page")).toBe(false);
    expect(result2.allowedToolNames.has("oncall_ack")).toBe(false);
  });

  test("executor blocks the tool after deactivation — allowedToolNames excludes it", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
    };

    const resolveTools = makeResolveTools(baseToolDefs);

    // Turn 1: both skills active, both tools allowed
    const history1: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    const result1 = resolveTools(history1);
    expect(result1.allowedToolNames.has("oncall_page")).toBe(true);
    expect(result1.allowedToolNames.has("deploy_run")).toBe(true);

    // Turn 2: oncall marker gone — its tool should be blocked
    const history2: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];
    const result2 = resolveTools(history2);

    // oncall_page is no longer in allowedToolNames — executor would block it
    expect(result2.allowedToolNames.has("oncall_page")).toBe(false);
    // deploy_run remains allowed
    expect(result2.allowedToolNames.has("deploy_run")).toBe(true);
    // Core tools remain allowed
    for (const core of CORE_TOOL_NAMES) {
      expect(result2.allowedToolNames.has(core)).toBe(true);
    }
  });

  test("unregisterSkillTools is called for deactivated skill", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
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

    expect(mockUnregisteredSkillIds).toContain("deploy");
    expect(mockUnregisteredSkillIds).not.toContain("oncall");
  });

  test("all skills deactivate when all markers leave history", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
    };

    const resolveTools = makeResolveTools(baseToolDefs);

    // Turn 1: both skills active
    const history1: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    const result1 = resolveTools(history1);
    // Only base tools in definitions — skill tools dispatched via skill_execute
    expect(result1.toolDefinitions).toHaveLength(2);

    // Clear tracking before turn 2
    mockUnregisteredSkillIds = [];

    // Turn 2: all markers gone (e.g. context window fully truncated)
    const history2: Message[] = [
      { role: "user", content: [{ type: "text", text: "Continue working" }] },
    ];
    const result2 = resolveTools(history2);

    // Still only base tools (same as turn 1)
    expect(result2.toolDefinitions).toHaveLength(2);
    expect(result2.toolDefinitions.map((d) => d.name)).toEqual([
      "file_read",
      "bash",
    ]);

    // Both skills were unregistered
    expect(mockUnregisteredSkillIds).toContain("deploy");
    expect(mockUnregisteredSkillIds).toContain("oncall");

    // No skill tools in allowed set
    expect(result2.allowedToolNames.has("deploy_run")).toBe(false);
    expect(result2.allowedToolNames.has("oncall_page")).toBe(false);

    // Core tools still present
    for (const core of CORE_TOOL_NAMES) {
      expect(result2.allowedToolNames.has(core)).toBe(true);
    }
  });

  test("skill can reactivate after deactivation", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
    };

    const resolveTools = makeResolveTools(baseToolDefs);

    // Turn 1: deploy active
    const history1: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];
    const result1 = resolveTools(history1);
    expect(result1.allowedToolNames.has("deploy_run")).toBe(true);

    // Turn 2: marker gone — deactivated
    const history2: Message[] = [];
    const result2 = resolveTools(history2);
    expect(result2.allowedToolNames.has("deploy_run")).toBe(false);

    // Turn 3: marker reappears — reactivated
    const history3: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];
    const result3 = resolveTools(history3);
    expect(result3.allowedToolNames.has("deploy_run")).toBe(true);
    // Skill tools not in definitions — dispatched via skill_execute
    expect(result3.toolDefinitions.map((d) => d.name)).not.toContain(
      "deploy_run",
    );
  });
});

// ---------------------------------------------------------------------------
// Slash preactivation tests
// ---------------------------------------------------------------------------

describe("slash preactivation through session processing", () => {
  let sessionState: Map<string, string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("slash-known skill has its tools in allowedToolNames on first projection (turn-0)", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run", "deploy_status"]) };

    // Empty history — no loaded_skill markers yet. The skill is preactivated
    // via slash resolution, so its tools should be available immediately.
    const emptyHistory: Message[] = [];

    const result = projectSkillTools(emptyHistory, {
      preactivatedSkillIds: ["deploy"],
      previouslyActiveSkillIds: sessionState,
    });

    // Tool definitions are no longer sent to the LLM
    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(
      new Set(["deploy_run", "deploy_status"]),
    );
  });

  test("preactivation is request-scoped — does not persist to unrelated runs", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };

    // First request: preactivated via slash command
    const result1 = projectSkillTools([], {
      preactivatedSkillIds: ["deploy"],
      previouslyActiveSkillIds: sessionState,
    });
    expect(result1.toolDefinitions).toEqual([]);
    expect(result1.allowedToolNames.has("deploy_run")).toBe(true);

    // Second request: no preactivation, no history markers.
    // Without preactivated IDs, the skill should not appear.
    const result2 = projectSkillTools([], {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result2.toolDefinitions).toEqual([]);
    expect(result2.allowedToolNames.has("deploy_run")).toBe(false);
  });

  test("preactivated skill tools merge with history-derived skills on turn-0", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
    };

    // History has an oncall marker from a previous exchange
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];

    // deploy is preactivated via slash, oncall is from history
    const result = projectSkillTools(history, {
      preactivatedSkillIds: ["deploy"],
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(
      new Set(["deploy_run", "oncall_page"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Bundled skill pipeline integration tests
// ---------------------------------------------------------------------------

const GMAIL_TOOL_NAMES = [
  "gmail_search",
  "gmail_list_messages",
  "gmail_get_message",
  "gmail_mark_read",
  "gmail_draft",
  "gmail_archive",
  "gmail_label",
  "gmail_trash",
  "gmail_send",
  "gmail_unsubscribe",
] as const;

describe("bundled skill: gmail", () => {
  let sessionState: Map<string, string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("gmail skill activation via loaded_skill marker registers all 11 tools in allowedToolNames", () => {
    mockCatalog = [makeSkill("gmail", "/path/to/bundled-skills/gmail")];
    mockManifests = { gmail: makeManifest([...GMAIL_TOOL_NAMES]) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="gmail" />'),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(new Set(GMAIL_TOOL_NAMES));
  });

  test("gmail tools are NOT available when gmail skill is not in active context", () => {
    mockCatalog = [makeSkill("gmail", "/path/to/bundled-skills/gmail")];
    mockManifests = { gmail: makeManifest([...GMAIL_TOOL_NAMES]) };

    // No loaded_skill marker for gmail in history
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toHaveLength(0);
    expect(result.allowedToolNames.size).toBe(0);
    for (const name of GMAIL_TOOL_NAMES) {
      expect(result.allowedToolNames.has(name)).toBe(false);
    }
  });
});

describe("bundled skill: claude-code", () => {
  let sessionState: Map<string, string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("claude-code skill activation registers claude_code in allowedToolNames", () => {
    mockCatalog = [
      makeSkill("claude-code", "/path/to/bundled-skills/claude-code"),
    ];
    mockManifests = { "claude-code": makeManifest(["claude_code"]) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="claude-code" />'),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(new Set(["claude_code"]));
  });

  test("claude_code tool is absent when claude-code skill is not active", () => {
    mockCatalog = [
      makeSkill("claude-code", "/path/to/bundled-skills/claude-code"),
    ];
    mockManifests = { "claude-code": makeManifest(["claude_code"]) };

    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toHaveLength(0);
    expect(result.allowedToolNames.has("claude_code")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bundled skill: app-builder
// ---------------------------------------------------------------------------

const APP_BUILDER_TOOL_NAMES = [
  "app_create",
  "app_list",
  "app_query",
  "app_update",
  "app_delete",
  "app_file_list",
  "app_file_read",
  "app_file_edit",
  "app_file_write",
] as const;

describe("bundled skill: app-builder", () => {
  let sessionState: Map<string, string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("app-builder skill activation registers all 9 canonical non-proxy tools in allowedToolNames", () => {
    mockCatalog = [
      makeSkill("app-builder", "/path/to/bundled-skills/app-builder"),
    ];
    mockManifests = {
      "app-builder": makeManifest([...APP_BUILDER_TOOL_NAMES]),
    };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="app-builder" />'),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(new Set(APP_BUILDER_TOOL_NAMES));
  });

  test("app-builder tools are NOT available when skill is not in active context", () => {
    mockCatalog = [
      makeSkill("app-builder", "/path/to/bundled-skills/app-builder"),
    ];
    mockManifests = {
      "app-builder": makeManifest([...APP_BUILDER_TOOL_NAMES]),
    };

    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toHaveLength(0);
    expect(result.allowedToolNames.size).toBe(0);
    for (const name of APP_BUILDER_TOOL_NAMES) {
      expect(result.allowedToolNames.has(name)).toBe(false);
    }
  });

  test("skill-projected app tools use host execution (script runners)", () => {
    mockCatalog = [
      makeSkill("app-builder", "/path/to/bundled-skills/app-builder"),
    ];
    mockManifests = {
      "app-builder": makeManifest([...APP_BUILDER_TOOL_NAMES]),
    };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="app-builder" />'),
    ];

    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    const tools = mockRegisteredTools.get("app-builder");
    expect(tools).toBeDefined();
    expect(tools!.length).toBe(9);

    // All tools should have skill origin metadata
    for (const tool of tools!) {
      expect(tool.origin).toBe("skill");
      expect(tool.ownerSkillId).toBe("app-builder");
    }
  });
});

// ---------------------------------------------------------------------------
// Bundled skill: browser
// ---------------------------------------------------------------------------

describe("bundled skill: browser", () => {
  let sessionState: Map<string, string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("browser skill activation via loaded_skill marker registers all 14 tools in allowedToolNames", () => {
    mockCatalog = [makeSkill("browser", "/path/to/bundled-skills/browser")];
    mockManifests = { browser: makeManifest([...BROWSER_TOOL_NAMES]) };

    const history: Message[] = [
      ...buildSkillLoadHistory("browser", "v1:testhash"),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(new Set(BROWSER_TOOL_NAMES));
  });

  test("browser tools are NOT available when browser skill is not in active context", () => {
    mockCatalog = [makeSkill("browser", "/path/to/bundled-skills/browser")];
    mockManifests = { browser: makeManifest([...BROWSER_TOOL_NAMES]) };

    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toHaveLength(0);
    expect(result.allowedToolNames.size).toBe(0);
    for (const name of BROWSER_TOOL_NAMES) {
      expect(result.allowedToolNames.has(name)).toBe(false);
    }
  });

  test("browser skill tools have skill origin metadata", () => {
    mockCatalog = [makeSkill("browser", "/path/to/bundled-skills/browser")];
    mockManifests = { browser: makeManifest([...BROWSER_TOOL_NAMES]) };

    const history: Message[] = [
      ...buildSkillLoadHistory("browser", "v1:testhash"),
    ];

    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    const tools = mockRegisteredTools.get("browser");
    expect(tools).toBeDefined();
    expect(tools!.length).toBe(14);

    for (const tool of tools!) {
      expect(tool.origin).toBe("skill");
      expect(tool.ownerSkillId).toBe("browser");
    }
  });
});

// ---------------------------------------------------------------------------
// Tamper detection regression tests
// ---------------------------------------------------------------------------

describe("tamper detection", () => {
  let sessionState: Map<string, string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("file mutation after projection invalidates the stored hash, causing re-registration on next turn", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };
    mockVersionHashes = { deploy: "v1:original-file-hash" };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // Turn 1: project with original hash
    const result1 = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    expect(result1.toolDefinitions).toEqual([]);
    expect(result1.allowedToolNames.has("deploy_run")).toBe(true);
    expect(sessionState.get("deploy")).toBe("v1:original-file-hash");

    // Simulate file mutation on disk — the hash changes
    mockVersionHashes = { deploy: "v1:tampered-file-hash" };

    // Turn 2: re-project detects hash drift and re-registers
    mockUnregisteredSkillIds = [];
    const result2 = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    // Tools are still available (re-registered with new hash)
    expect(result2.toolDefinitions).toEqual([]);
    expect(result2.allowedToolNames.has("deploy_run")).toBe(true);

    // Old tools were unregistered before new ones registered
    expect(mockUnregisteredSkillIds).toContain("deploy");

    // Session state now tracks the new hash
    expect(sessionState.get("deploy")).toBe("v1:tampered-file-hash");

    // Refcount stays at 1 (unregister decremented, re-register incremented)
    expect(mockSkillRefCount.get("deploy")).toBe(1);
  });

  test("unmodified skill file does NOT trigger re-registration across multiple turns", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };
    mockVersionHashes = { deploy: "v1:stable-content-hash" };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // Turn 1: initial projection
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    expect(mockSkillRefCount.get("deploy")).toBe(1);

    // Turns 2-4: hash stays the same, no re-registration should occur
    for (let turn = 2; turn <= 4; turn++) {
      mockUnregisteredSkillIds = [];
      const result = projectSkillTools(history, {
        previouslyActiveSkillIds: sessionState,
      });
      expect(result.toolDefinitions).toEqual([]);
      expect(result.allowedToolNames.has("deploy_run")).toBe(true);
      expect(mockUnregisteredSkillIds).not.toContain("deploy");
      expect(mockSkillRefCount.get("deploy")).toBe(1);
    }
  });

  test("re-projection after tamper produces tools with the updated hash", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run", "deploy_status"]) };
    mockVersionHashes = { deploy: "v1:hash-before-edit" };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // Turn 1: initial projection
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    expect(sessionState.get("deploy")).toBe("v1:hash-before-edit");

    // Simulate tamper: file changes on disk
    mockVersionHashes = { deploy: "v1:hash-after-edit" };

    // Turn 2: re-projection picks up the new hash
    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(
      new Set(["deploy_run", "deploy_status"]),
    );
    expect(sessionState.get("deploy")).toBe("v1:hash-after-edit");
  });

  test("multiple skills with only one tampered triggers selective re-registration", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
    };
    mockVersionHashes = {
      deploy: "v1:deploy-hash-v1",
      oncall: "v1:oncall-hash-v1",
    };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];

    // Turn 1: both skills registered
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    expect(sessionState.get("deploy")).toBe("v1:deploy-hash-v1");
    expect(sessionState.get("oncall")).toBe("v1:oncall-hash-v1");

    // Tamper only deploy
    mockVersionHashes = {
      deploy: "v1:deploy-hash-v2-tampered",
      oncall: "v1:oncall-hash-v1", // unchanged
    };
    mockUnregisteredSkillIds = [];

    // Turn 2: only deploy should be re-registered
    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(
      new Set(["deploy_run", "oncall_page"]),
    );

    // Only deploy was unregistered (for re-registration), oncall was untouched
    expect(mockUnregisteredSkillIds).toContain("deploy");
    expect(mockUnregisteredSkillIds).not.toContain("oncall");

    // Hashes updated accordingly
    expect(sessionState.get("deploy")).toBe("v1:deploy-hash-v2-tampered");
    expect(sessionState.get("oncall")).toBe("v1:oncall-hash-v1");
  });

  test("hash failure (e.g., unreadable directory) causes fallback re-registration", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };
    mockVersionHashes = { deploy: "v1:initial-hash" };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    expect(sessionState.get("deploy")).toBe("v1:initial-hash");

    // Make computeSkillVersionHash throw to exercise the catch branch
    // in session-skill-tools.ts that falls back to `unknown-${Date.now()}`
    mockVersionHashErrors.add("deploy");
    mockUnregisteredSkillIds = [];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames.has("deploy_run")).toBe(true);

    // The exception triggers re-registration since the fallback hash
    // (`unknown-<timestamp>`) will never match the stored hash
    expect(mockUnregisteredSkillIds).toContain("deploy");
    expect(sessionState.get("deploy")).toMatch(/^unknown-\d+$/);
  });
});

// ---------------------------------------------------------------------------
// resetSkillToolProjection tests
// ---------------------------------------------------------------------------

describe("resetSkillToolProjection", () => {
  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
  });

  test("unregisters all tracked skills and clears the map", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
    };

    const trackedIds = new Map<string, string>();

    // Activate both skills
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];
    projectSkillTools(history, { previouslyActiveSkillIds: trackedIds });
    expect(trackedIds.size).toBe(2);

    mockUnregisteredSkillIds = [];
    resetSkillToolProjection(trackedIds);

    expect(mockUnregisteredSkillIds).toContain("deploy");
    expect(mockUnregisteredSkillIds).toContain("oncall");
    expect(trackedIds.size).toBe(0);
  });

  test("no-op when called with undefined", () => {
    mockUnregisteredSkillIds = [];
    resetSkillToolProjection(undefined);
    expect(mockUnregisteredSkillIds).toHaveLength(0);
  });

  test("no-op when called with empty map", () => {
    mockUnregisteredSkillIds = [];
    resetSkillToolProjection(new Map());
    expect(mockUnregisteredSkillIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Versioned marker integration tests
// ---------------------------------------------------------------------------

describe("versioned markers through session projection", () => {
  let sessionState: Map<string, string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("versioned marker activates skill tools the same as legacy marker", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" version="v1:abc123" />'),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(new Set(["deploy_run"]));
  });

  test("mixed legacy and versioned markers both project tools", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
    };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages(
        '<loaded_skill id="oncall" version="v1:deadbeef" />',
      ),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(
      new Set(["deploy_run", "oncall_page"]),
    );
  });

  test("versioned marker skill deactivates when removed from history", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };

    // Turn 1: versioned skill active
    const history1: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" version="v1:abc123" />'),
    ];
    projectSkillTools(history1, { previouslyActiveSkillIds: sessionState });
    expect(sessionState.has("deploy")).toBe(true);

    // Turn 2: marker removed
    mockUnregisteredSkillIds = [];
    const result2 = projectSkillTools([], {
      previouslyActiveSkillIds: sessionState,
    });
    expect(result2.toolDefinitions).toEqual([]);
    expect(mockUnregisteredSkillIds).toContain("deploy");
  });
});

// ---------------------------------------------------------------------------
// Hash change re-prompt regression tests (PR 35)
// Verify that version hash changes trigger re-registration and that the
// session state accurately tracks the new hash, which downstream components
// use to decide whether cached approvals still apply.
// ---------------------------------------------------------------------------

describe("hash change re-prompt regressions (PR 35)", () => {
  let sessionState: Map<string, string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("approve v1, edit skill (hash changes), v2 triggers re-registration with new hash", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };
    mockVersionHashes = { deploy: "v1:approved-hash" };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // Turn 1: skill approved and registered with v1 hash
    const result1 = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });
    expect(result1.toolDefinitions).toEqual([]);
    expect(result1.allowedToolNames.has("deploy_run")).toBe(true);
    expect(sessionState.get("deploy")).toBe("v1:approved-hash");
    expect(mockSkillRefCount.get("deploy")).toBe(1);

    // Simulate skill edit — hash changes on disk
    mockVersionHashes = { deploy: "v2:edited-hash" };
    mockUnregisteredSkillIds = [];

    // Turn 2: projection detects hash drift, unregisters old, re-registers new
    const result2 = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result2.toolDefinitions).toEqual([]);
    expect(result2.allowedToolNames.has("deploy_run")).toBe(true);

    // Old version was unregistered
    expect(mockUnregisteredSkillIds).toContain("deploy");

    // Session state updated to the new hash
    expect(sessionState.get("deploy")).toBe("v2:edited-hash");

    // Ref count balanced (unregister decremented, re-register incremented)
    expect(mockSkillRefCount.get("deploy")).toBe(1);
  });

  test("two consecutive edits each trigger re-registration with correct hash", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };
    mockVersionHashes = { deploy: "v1:first-version" };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // Turn 1: initial registration
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    expect(sessionState.get("deploy")).toBe("v1:first-version");

    // Edit 1: hash changes to v2
    mockVersionHashes = { deploy: "v2:second-version" };
    mockUnregisteredSkillIds = [];
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    expect(sessionState.get("deploy")).toBe("v2:second-version");
    expect(mockUnregisteredSkillIds).toContain("deploy");

    // Edit 2: hash changes to v3
    mockVersionHashes = { deploy: "v3:third-version" };
    mockUnregisteredSkillIds = [];
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    expect(sessionState.get("deploy")).toBe("v3:third-version");
    expect(mockUnregisteredSkillIds).toContain("deploy");

    // Ref count stays at 1 through all edits
    expect(mockSkillRefCount.get("deploy")).toBe(1);
  });

  test("hash change in one skill does not affect co-active skill with stable hash", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
    };
    mockVersionHashes = {
      deploy: "v1:deploy-stable",
      oncall: "v1:oncall-original",
    };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];

    // Turn 1: both skills registered
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    expect(sessionState.get("deploy")).toBe("v1:deploy-stable");
    expect(sessionState.get("oncall")).toBe("v1:oncall-original");

    // Edit only oncall
    mockVersionHashes = {
      deploy: "v1:deploy-stable", // unchanged
      oncall: "v2:oncall-edited",
    };
    mockUnregisteredSkillIds = [];

    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    // Only oncall was re-registered
    expect(mockUnregisteredSkillIds).toContain("oncall");
    expect(mockUnregisteredSkillIds).not.toContain("deploy");

    // Hashes updated correctly
    expect(sessionState.get("deploy")).toBe("v1:deploy-stable");
    expect(sessionState.get("oncall")).toBe("v2:oncall-edited");
  });

  test("registered tools carry updated ownerSkillId after hash change re-registration", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };
    mockVersionHashes = { deploy: "v1:pre-edit" };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // Turn 1
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    const toolsV1 = mockRegisteredTools.get("deploy");
    expect(toolsV1).toBeDefined();
    expect(toolsV1!.length).toBe(1);
    expect(toolsV1![0].ownerSkillId).toBe("deploy");

    // Edit
    mockVersionHashes = { deploy: "v2:post-edit" };
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    // After re-registration, tools should still be associated with the skill
    const toolsV2 = mockRegisteredTools.get("deploy");
    expect(toolsV2).toBeDefined();
    expect(toolsV2!.length).toBeGreaterThanOrEqual(1);
    expect(toolsV2![0].ownerSkillId).toBe("deploy");
  });
});

// ---------------------------------------------------------------------------
// Version hash plumbing regression tests
// Verify that createSkillToolsFromManifest receives the computed hash and
// that projected tools carry ownerSkillVersionHash, which downstream
// components (executor.ts) use to build policy context.
// ---------------------------------------------------------------------------

describe("version hash plumbing to projected tools", () => {
  let sessionState: Map<string, string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("projected tools carry ownerSkillVersionHash matching the computed hash", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run", "deploy_status"]) };
    mockVersionHashes = { deploy: "v1:secure-hash-abc" };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    const tools = mockRegisteredTools.get("deploy");
    expect(tools).toBeDefined();
    expect(tools!.length).toBe(2);

    // Every tool created for this skill must carry the version hash
    for (const tool of tools!) {
      expect(tool.ownerSkillVersionHash).toBe("v1:secure-hash-abc");
    }
  });

  test("after hash change re-registration, new tools carry the updated hash", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };
    mockVersionHashes = { deploy: "v1:hash-before" };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    // Turn 1: register with original hash
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    const toolsV1 = mockRegisteredTools.get("deploy");
    expect(toolsV1).toBeDefined();
    expect(toolsV1![0].ownerSkillVersionHash).toBe("v1:hash-before");

    // Simulate file edit — hash changes
    mockVersionHashes = { deploy: "v2:hash-after" };

    // Turn 2: re-registration with new hash
    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });
    const toolsV2 = mockRegisteredTools.get("deploy");
    expect(toolsV2).toBeDefined();

    // The most recently registered tool should carry the new hash
    const lastTool = toolsV2![toolsV2!.length - 1];
    expect(lastTool.ownerSkillVersionHash).toBe("v2:hash-after");
  });

  test("tools for multiple co-active skills each carry their own version hash", () => {
    mockCatalog = [makeSkill("deploy"), makeSkill("oncall")];
    mockManifests = {
      deploy: makeManifest(["deploy_run"]),
      oncall: makeManifest(["oncall_page"]),
    };
    mockVersionHashes = {
      deploy: "v1:deploy-hash-123",
      oncall: "v1:oncall-hash-456",
    };

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
      ...skillLoadMessages('<loaded_skill id="oncall" />'),
    ];

    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    const deployTools = mockRegisteredTools.get("deploy");
    expect(deployTools).toBeDefined();
    expect(deployTools![0].ownerSkillVersionHash).toBe("v1:deploy-hash-123");

    const oncallTools = mockRegisteredTools.get("oncall");
    expect(oncallTools).toBeDefined();
    expect(oncallTools![0].ownerSkillVersionHash).toBe("v1:oncall-hash-456");
  });

  test("default hash is used and plumbed when no explicit hash override is set", () => {
    mockCatalog = [makeSkill("deploy")];
    mockManifests = { deploy: makeManifest(["deploy_run"]) };
    // No mockVersionHashes override — mock returns 'v1:default-hash-deploy'

    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="deploy" />'),
    ];

    projectSkillTools(history, { previouslyActiveSkillIds: sessionState });

    const tools = mockRegisteredTools.get("deploy");
    expect(tools).toBeDefined();
    expect(tools![0].ownerSkillVersionHash).toBe("v1:default-hash-deploy");
  });
});

// ---------------------------------------------------------------------------
// Child skill includes: no auto-activation
// ---------------------------------------------------------------------------

describe("includes metadata does not auto-activate child skill tools", () => {
  let sessionState: Map<string, string>;

  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    mockVersionHashes = {};
    mockVersionHashErrors = new Set();
    sessionState = new Map<string, string>();
  });

  test("parent with includes — only parent tools projected when only parent marker present", () => {
    // Parent skill declares child in its includes metadata
    const parentSkill = makeSkill("parent-skill");
    parentSkill.includes = ["child-skill"];

    mockCatalog = [parentSkill, makeSkill("child-skill")];
    mockManifests = {
      "parent-skill": makeManifest(["parent_action"]),
      "child-skill": makeManifest(["child_action"]),
    };

    // Only parent marker in history — child is NOT loaded
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="parent-skill" />'),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    // Only parent tools should be projected
    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(new Set(["parent_action"]));

    // Child tools must NOT be present
    expect(result.allowedToolNames.has("child_action")).toBe(false);
  });

  test("child tools appear only after explicit child loaded_skill marker", () => {
    const parentSkill = makeSkill("parent-skill");
    parentSkill.includes = ["child-skill"];

    mockCatalog = [parentSkill, makeSkill("child-skill")];
    mockManifests = {
      "parent-skill": makeManifest(["parent_action"]),
      "child-skill": makeManifest(["child_action"]),
    };

    // Both parent AND child markers present — both should be active
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="parent-skill" />'),
      ...skillLoadMessages('<loaded_skill id="child-skill" />'),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames).toEqual(
      new Set(["parent_action", "child_action"]),
    );
  });

  test("child tools are absent even with deep include chain — only markers matter", () => {
    const grandparent = makeSkill("grandparent");
    grandparent.includes = ["parent"];
    const parent = makeSkill("parent");
    parent.includes = ["child"];

    mockCatalog = [grandparent, parent, makeSkill("child")];
    mockManifests = {
      grandparent: makeManifest(["gp_action"]),
      parent: makeManifest(["parent_action"]),
      child: makeManifest(["child_action"]),
    };

    // Only grandparent marker — despite transitive includes, only grandparent tools active
    const history: Message[] = [
      ...skillLoadMessages('<loaded_skill id="grandparent" />'),
    ];

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.toolDefinitions).toEqual([]);
    expect(result.allowedToolNames.has("gp_action")).toBe(true);
    expect(result.allowedToolNames.has("parent_action")).toBe(false);
    expect(result.allowedToolNames.has("child_action")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Browser skill migration harness — validates shared test helpers
// ---------------------------------------------------------------------------

describe("browser skill migration harness", () => {
  test("buildSkillLoadHistory creates valid skill_load history", () => {
    const history = buildSkillLoadHistory("browser", "v1:abc123");
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe("assistant");
    expect(history[1].role).toBe("user");
    // Verify tool_use block
    const toolUse = history[0].content[0] as ToolUseContent;
    expect(toolUse.type).toBe("tool_use");
    expect(toolUse.name).toBe("skill_load");
    // Verify tool_result has marker
    const toolResult = history[1].content[0] as ToolResultContent;
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.content).toContain(
      '<loaded_skill id="browser" version="v1:abc123" />',
    );
  });

  test("buildSkillLoadHistory generates unique tool_use IDs per call", () => {
    const h1 = buildSkillLoadHistory("browser", "v1:abc");
    const h2 = buildSkillLoadHistory("browser", "v1:def");
    const id1 = (h1[0].content[0] as { id: string }).id;
    const id2 = (h2[0].content[0] as { id: string }).id;
    expect(id1).not.toBe(id2);
  });

  test("BROWSER_TOOL_NAMES contains all 14 browser tools", () => {
    expect(BROWSER_TOOL_NAMES).toHaveLength(14);
    expect(BROWSER_TOOL_NAMES).toContain("browser_navigate");
    expect(BROWSER_TOOL_NAMES).toContain("browser_fill_credential");
  });

  test("assertBrowserToolsPresent passes when all tools present", () => {
    expect(() =>
      assertBrowserToolsPresent([...BROWSER_TOOL_NAMES, "extra_tool"]),
    ).not.toThrow();
  });

  test("assertBrowserToolsPresent fails when tool missing", () => {
    expect(() => assertBrowserToolsPresent(["browser_navigate"])).toThrow();
  });

  test("assertBrowserToolsAbsent passes when no browser tools present", () => {
    expect(() =>
      assertBrowserToolsAbsent(["file_read", "web_search"]),
    ).not.toThrow();
  });

  test("assertBrowserToolsAbsent fails when browser tool present", () => {
    expect(() => assertBrowserToolsAbsent(["browser_navigate"])).toThrow();
  });
});
