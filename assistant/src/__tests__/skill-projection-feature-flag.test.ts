/**
 * Tests that projectSkillTools drops flag-OFF active skills from projected
 * tools, even when conversation history contains old markers for those skills.
 */
import * as realFs from "node:fs";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillSummary, SkillToolManifest } from "../config/skills.js";
import { RiskLevel } from "../permissions/types.js";
import type { Message } from "../providers/types.js";
import type { Tool } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockCatalog: SkillSummary[] = [];
let mockManifests: Record<string, SkillToolManifest | null> = {};
let mockRegisteredTools: Map<string, Tool[]> = new Map();
let mockUnregisteredSkillIds: string[] = [];
let mockSkillRefCount: Map<string, number> = new Map();

let currentConfig: Record<string, unknown> = {};
const DECLARED_SKILL_ID = "hatch-new-assistant";
const DECLARED_FLAG_KEY = "feature_flags.hatch-new-assistant.enabled";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => mockCatalog,
  checkSkillRequirements: () => ({ satisfied: true, missing: [] }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => currentConfig,
  loadConfig: () => currentConfig,
  invalidateConfigCache: () => {},
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (
    key: string,
    config: Record<string, unknown>,
  ) => {
    const vals = (
      config as {
        assistantFeatureFlagValues?: Record<string, boolean>;
      }
    ).assistantFeatureFlagValues;
    if (vals && typeof vals[key] === "boolean") return vals[key];
    return true; // default enabled
  },
  loadDefaultsRegistry: () => ({}),
  getAssistantFeatureFlagDefaults: () => ({}),
  _resetDefaultsCache: () => {},
}));

mock.module("../config/skill-state.js", () => ({
  skillFlagKey: (skillId: string) => `feature_flags.${skillId}.enabled`,
}));

mock.module("../skills/active-skill-tools.js", () => {
  const parseMarkers = (messages: Message[]) => {
    const skillLoadUseIds = new Set<string>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.name === "skill_load") {
          skillLoadUseIds.add(block.id);
        }
      }
    }
    const re = /<loaded_skill\s+id="([^"]+)"(?:\s+version="([^"]+)")?\s*\/>/g;
    const seen = new Set<string>();
    const entries: Array<{ id: string; version?: string }> = [];
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type !== "tool_result") continue;
        if (!skillLoadUseIds.has(block.tool_use_id)) continue;
        const text = block.content;
        if (!text) continue;
        for (const m of text.matchAll(re)) {
          if (!seen.has(m[1])) {
            seen.add(m[1]);
            const entry: { id: string; version?: string } = { id: m[1] };
            if (m[2]) entry.version = m[2];
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
    const parts = filePath.split("/");
    const skillId = parts[parts.length - 2];
    const manifest = mockManifests[skillId];
    if (!manifest) throw new Error(`Mock: no manifest for skill "${skillId}"`);
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
  isDebug: () => false,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { projectSkillTools, resetSkillToolProjection } =
  await import("../daemon/session-skill-tools.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(id: string): SkillSummary {
  return {
    id,
    name: id,
    displayName: id,
    description: `Skill ${id}`,
    directoryPath: `/skills/${id}`,
    skillFilePath: `/skills/${id}/SKILL.md`,
    userInvocable: true,
    disableModelInvocation: false,
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

/** Build conversation history with a loaded_skill marker. */
function buildHistoryWithMarker(skillId: string): Message[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-1",
          name: "skill_load",
          input: { skill: skillId },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: `Loaded.\n\n<loaded_skill id="${skillId}" version="v1:default-hash-${skillId}" />`,
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("projectSkillTools feature flag enforcement", () => {
  beforeEach(() => {
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    currentConfig = {};
    resetSkillToolProjection();
  });

  test("no skill tools projected for flag OFF skill even with old markers", () => {
    mockCatalog = [makeSkill(DECLARED_SKILL_ID)];
    mockManifests = {
      [DECLARED_SKILL_ID]: makeManifest(["browser_navigate", "browser_click"]),
    };

    // History contains a marker from before the flag was turned off
    const history = buildHistoryWithMarker(DECLARED_SKILL_ID);
    const prevActive = new Map<string, string>();

    // Feature flag is OFF
    currentConfig = {
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: false },
    };

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: prevActive,
    });

    // No tools should be projected
    expect(result.toolDefinitions).toHaveLength(0);
    expect(result.allowedToolNames.size).toBe(0);
  });

  test("skill tools projected normally when flag is ON", () => {
    mockCatalog = [makeSkill(DECLARED_SKILL_ID)];
    mockManifests = {
      [DECLARED_SKILL_ID]: makeManifest(["browser_navigate", "browser_click"]),
    };

    const history = buildHistoryWithMarker(DECLARED_SKILL_ID);
    const prevActive = new Map<string, string>();

    // Feature flag is ON
    currentConfig = {
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: true },
    };

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: prevActive,
    });

    expect(result.toolDefinitions).toHaveLength(2);
    expect(result.allowedToolNames.has("browser_navigate")).toBe(true);
    expect(result.allowedToolNames.has("browser_click")).toBe(true);
  });

  test("skill tools projected normally when flag key is absent (defaults to enabled)", () => {
    mockCatalog = [makeSkill(DECLARED_SKILL_ID)];
    mockManifests = { [DECLARED_SKILL_ID]: makeManifest(["browser_navigate"]) };

    const history = buildHistoryWithMarker(DECLARED_SKILL_ID);
    const prevActive = new Map<string, string>();

    // No overrides — should default to enabled
    currentConfig = {};

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: prevActive,
    });

    expect(result.toolDefinitions).toHaveLength(1);
    expect(result.allowedToolNames.has("browser_navigate")).toBe(true);
  });

  test("mixed flag-on and flag-off skills — only flag-on tools projected", () => {
    mockCatalog = [makeSkill(DECLARED_SKILL_ID), makeSkill("twitter")];
    mockManifests = {
      [DECLARED_SKILL_ID]: makeManifest(["browser_navigate"]),
      twitter: makeManifest(["twitter_post"]),
    };

    const history: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "skill_load",
            input: { skill: DECLARED_SKILL_ID },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-1",
            content: `<loaded_skill id="${DECLARED_SKILL_ID}" version="v1:default-hash-${DECLARED_SKILL_ID}" />`,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-2",
            name: "skill_load",
            input: { skill: "twitter" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-2",
            content:
              '<loaded_skill id="twitter" version="v1:default-hash-twitter" />',
          },
        ],
      },
    ];
    const prevActive = new Map<string, string>();

    // Declared skill is OFF, twitter is undeclared with no persisted override so remains ON.
    currentConfig = {
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: false },
    };

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: prevActive,
    });

    const toolNames = result.toolDefinitions.map((t) => t.name);
    expect(toolNames).toContain("twitter_post");
    expect(toolNames).not.toContain("browser_navigate");
  });
});
