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
const DECLARED_SKILL_ID = "contacts";
const DECLARED_FLAG_KEY = "feature_flags.contacts.enabled";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => mockCatalog,
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
}));

mock.module("../config/skill-state.js", () => ({
  skillFlagKey: (skill: { featureFlag?: string }) =>
    skill.featureFlag
      ? `feature_flags.${skill.featureFlag}.enabled`
      : undefined,
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
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { projectSkillTools, resetSkillToolProjection } =
  await import("../daemon/conversation-skill-tools.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(id: string, featureFlag?: string): SkillSummary {
  return {
    id,
    name: id,
    displayName: id,
    description: `Skill ${id}`,
    directoryPath: `/skills/${id}`,
    skillFilePath: `/skills/${id}/SKILL.md`,

    source: "managed",
    featureFlag,
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
    mockCatalog = [makeSkill(DECLARED_SKILL_ID, DECLARED_SKILL_ID)];
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
    mockCatalog = [makeSkill(DECLARED_SKILL_ID, DECLARED_SKILL_ID)];
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

    // Tool definitions are no longer returned (dispatched via skill_execute),
    // but allowedToolNames should contain the registered tool names.
    expect(result.toolDefinitions).toHaveLength(0);
    expect(result.allowedToolNames.size).toBe(2);
    expect(result.allowedToolNames.has("browser_navigate")).toBe(true);
    expect(result.allowedToolNames.has("browser_click")).toBe(true);
  });

  test("skill tools projected normally when no featureFlag declared (never gated)", () => {
    mockCatalog = [makeSkill(DECLARED_SKILL_ID)];
    mockManifests = { [DECLARED_SKILL_ID]: makeManifest(["browser_navigate"]) };

    const history = buildHistoryWithMarker(DECLARED_SKILL_ID);
    const prevActive = new Map<string, string>();

    // No overrides — skill has no featureFlag so it's never gated
    currentConfig = {};

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: prevActive,
    });

    expect(result.toolDefinitions).toHaveLength(0);
    expect(result.allowedToolNames.size).toBe(1);
    expect(result.allowedToolNames.has("browser_navigate")).toBe(true);
  });

  test("mixed flag-on and flag-off skills — only flag-on tools projected", () => {
    mockCatalog = [
      makeSkill(DECLARED_SKILL_ID, DECLARED_SKILL_ID),
      makeSkill("plain-skill"),
    ];
    mockManifests = {
      [DECLARED_SKILL_ID]: makeManifest(["browser_navigate"]),
      "plain-skill": makeManifest(["plain_action"]),
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
            input: { skill: "plain-skill" },
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
              '<loaded_skill id="plain-skill" version="v1:default-hash-plain-skill" />',
          },
        ],
      },
    ];
    const prevActive = new Map<string, string>();

    // Declared skill is OFF, plain-skill is undeclared with no persisted override so remains ON.
    currentConfig = {
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: false },
    };

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: prevActive,
    });

    // Tool definitions are no longer returned; check allowedToolNames instead
    expect(result.allowedToolNames.has("plain_action")).toBe(true);
    expect(result.allowedToolNames.has("browser_navigate")).toBe(false);
  });
});
