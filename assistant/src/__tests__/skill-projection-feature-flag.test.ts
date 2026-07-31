/**
 * Tests that projectSkillTools drops flag-OFF active skills from projected
 * tools, even when conversation history contains old markers for those skills.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillSummary, SkillToolManifest } from "../config/skills.js";
import { RiskLevel } from "../permissions/types.js";
import type { Message } from "../providers/types.js";
import type { Tool } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let tmpRoot: string;
let mockCatalog: SkillSummary[] = [];
let mockManifests: Record<string, SkillToolManifest | null> = {};
let mockRegisteredTools: Map<string, Tool[]> = new Map();
let mockUnregisteredSkillIds: string[] = [];
let mockSkillRefCount: Map<string, number> = new Map();

const DECLARED_SKILL_ID = "contacts";
const DECLARED_FLAG_KEY = "contacts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => mockCatalog,
  // Pass-through: these tests don't exercise per-chat plugin scoping.
  filterSkillsByEnabledPlugins: (skills: unknown) => skills,
}));

mock.module("../config/skill-state.js", () => ({
  skillFlagKey: (skill: { featureFlag?: string }) =>
    skill.featureFlag || undefined,
}));

// Mock assistant-feature-flags to avoid loading the real module (which
// triggers file I/O and env-registry imports that hang in test context).
// The seed-state backdoor is the test-only helper module — we mirror
// production's design: tests reach into `feature-flag-cache.ts` (or its
// test-helper wrapper) to seed cached overrides, never through the
// resolver module itself.
let _mockOverrides: Record<string, boolean> = {};
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string, _config: unknown): boolean => {
    const explicit = _mockOverrides[key];
    if (typeof explicit === "boolean") {
      return explicit;
    }
    return false; // undeclared flags default to disabled
  },
  clearFeatureFlagOverridesCache: () => {
    _mockOverrides = {};
  },
  getAssistantFeatureFlagDefaults: () => ({}),
}));
mock.module("./feature-flag-test-helpers.js", () => ({
  setOverridesForTesting: (overrides: Record<string, boolean>) => {
    _mockOverrides = { ...overrides };
  },
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
        if (block.type !== "tool_result") {
          continue;
        }
        if (!skillLoadUseIds.has(block.tool_use_id)) {
          continue;
        }
        const text = block.content;
        if (!text) {
          continue;
        }
        for (const m of text.matchAll(re)) {
          if (!seen.has(m[1])) {
            seen.add(m[1]);
            const entry: { id: string; version?: string } = { id: m[1] };
            if (m[2]) {
              entry.version = m[2];
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
  // Mirrors the real factory: no skillId in/out — ownership is recorded by
  // the registry at `registerSkillTools(skillId, tools)` time.
  createSkillToolsFromManifest: (
    entries: SkillToolManifest["tools"],
    _skillDir: string,
    _versionHash: string,
    _bundled?: boolean,
  ): Tool[] => {
    return entries.map((entry) => ({
      name: entry.name,
      description: entry.description,
      category: entry.category,
      defaultRiskLevel: RiskLevel.Medium,
      executionTarget: "sandbox" as const,
      input_schema: entry.input_schema as object,
      execute: async () => ({ content: "", isError: false }),
    }));
  },
}));

mock.module("../tools/registry.js", () => ({
  // Matches the new signature: `registerSkillTools(skillId, tools)`. The
  // skillId comes from the caller (conversation-skill-tools) and is the
  // sole source of truth for ownership.
  registerSkillTools: (skillId: string, tools: Tool[]) => {
    const existing = mockRegisteredTools.get(skillId) ?? [];
    existing.push(...tools);
    mockRegisteredTools.set(skillId, existing);
    mockSkillRefCount.set(skillId, (mockSkillRefCount.get(skillId) ?? 0) + 1);
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
        if (tool.name === name) {
          found = tool;
        }
      }
    }
    return found;
  },
  resolveTool: (name: string): Tool | undefined => {
    let found: Tool | undefined;
    for (const tools of mockRegisteredTools.values()) {
      for (const tool of tools) {
        if (tool.name === name) {
          found = tool;
        }
      }
    }
    return found;
  },
  // Mirrors the registry's `ownersByName` accessor: derives the owning
  // skillId from `mockRegisteredTools` keying so the production
  // `getToolOwner(name)` call in `conversation-skill-tools.ts` resolves to
  // the same shape the real registry would return.
  getToolOwner: (
    name: string,
  ): { kind: "skill" | "plugin" | "mcp"; id: string } | undefined => {
    let ownerSkillId: string | undefined;
    for (const [skillId, tools] of mockRegisteredTools.entries()) {
      for (const tool of tools) {
        if (tool.name === name) {
          ownerSkillId = skillId;
        }
      }
    }
    return ownerSkillId === undefined
      ? undefined
      : { kind: "skill", id: ownerSkillId };
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

mock.module("../skills/version-hash.js", () => ({
  computeSkillVersionHash: (skillDir: string) => {
    const parts = skillDir.split("/");
    const skillId = parts[parts.length - 1];
    return `v1:default-hash-${skillId}`;
  },
}));

// Mock the skill_loaded telemetry dependencies of conversation-skill-tools so
// their heavy transitive imports (catalog-install → CLI program, sqlite) stay
// out of this import-light test.
mock.module("../skills/catalog-cache.js", () => ({
  getCachedCatalogSync: () => [],
}));
mock.module("../skills/install-meta.js", () => ({
  readInstallMeta: () => null,
  touchSkillLastUsed: () => false,
}));
mock.module("../telemetry/skill-loaded-events-store.js", () => ({
  recordSkillLoadedEvent: () => {},
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { projectSkillTools, resetSkillToolProjection } =
  await import("../daemon/conversation-skill-tools.js");
const { setOverridesForTesting } =
  await import("./feature-flag-test-helpers.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(id: string, featureFlag?: string): SkillSummary {
  // A real on-disk skill dir with a TOOLS.json so the production manifest
  // existence check (`existsSync(<dir>/TOOLS.json)`) passes for real; the
  // manifest's contents are supplied by the mocked `parseToolManifestFile`.
  const directoryPath = join(tmpRoot, id);
  mkdirSync(directoryPath, { recursive: true });
  writeFileSync(join(directoryPath, "TOOLS.json"), "{}");
  return {
    id,
    name: id,
    displayName: id,
    description: `Skill ${id}`,
    directoryPath,
    skillFilePath: join(directoryPath, "SKILL.md"),

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
    tmpRoot = mkdtempSync(join(tmpdir(), "skill-projection-flag-"));
    mockCatalog = [];
    mockManifests = {};
    mockRegisteredTools = new Map();
    mockUnregisteredSkillIds = [];
    mockSkillRefCount = new Map();
    setOverridesForTesting({});
    resetSkillToolProjection();
  });

  afterEach(() => {
    setOverridesForTesting({});
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("no skill tools projected for flag OFF skill even with old markers", () => {
    mockCatalog = [makeSkill(DECLARED_SKILL_ID, DECLARED_SKILL_ID)];
    mockManifests = {
      [DECLARED_SKILL_ID]: makeManifest(["browser_navigate", "browser_click"]),
    };

    // History contains a marker from before the flag was turned off
    const history = buildHistoryWithMarker(DECLARED_SKILL_ID);
    const prevActive = new Map<string, string>();

    // Feature flag is OFF — use protected directory override
    setOverridesForTesting({ [DECLARED_FLAG_KEY]: false });

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

    // Feature flag is ON — use protected directory override
    setOverridesForTesting({ [DECLARED_FLAG_KEY]: true });

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

    // Declared skill is OFF; plain-skill has no featureFlag so remains ON.
    setOverridesForTesting({ [DECLARED_FLAG_KEY]: false });

    const result = projectSkillTools(history, {
      previouslyActiveSkillIds: prevActive,
    });

    // Tool definitions are no longer returned; check allowedToolNames instead
    expect(result.allowedToolNames.has("plain_action")).toBe(true);
    expect(result.allowedToolNames.has("browser_navigate")).toBe(false);
  });
});
