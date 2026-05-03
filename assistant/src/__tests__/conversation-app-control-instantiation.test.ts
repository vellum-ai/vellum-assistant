/**
 * Tests for HostAppControlProxy instantiation in `prepareConversationForMessage`
 * (and the parallel block in `conversation-routes.ts`).
 *
 * Verifies that:
 *  - A macOS client connection unconditionally attaches a HostAppControlProxy
 *    and preactivates the `app-control` skill — regardless of whether the
 *    `app-control` feature flag is on or off. The flag is read only by the
 *    skill-projection layer, never gates the proxy.
 *  - A non-macOS client connection (where
 *    `supportsHostProxy(_, "host_app_control")` returns false) leaves the
 *    proxy unattached.
 *  - The skill-projection layer filters the `app-control` skill out of the
 *    projected tool list when the feature flag is off, even when it is in
 *    the preactivated set — proving that the gating point is the projection
 *    layer rather than the proxy attachment site.
 *
 * The first set of tests mirrors the production gating logic from
 * `prepareConversationForMessage` (in `assistant/src/daemon/process-message.ts`)
 * and the parallel block in `assistant/src/runtime/routes/conversation-routes.ts`
 * — both unconditionally instantiate `HostAppControlProxy` and preactivate
 * `"app-control"` when `supportsHostProxy(interfaceId, "host_app_control")`
 * returns true. Calling the real prepare/route helpers directly would require
 * mocking the full processMessage/handleSendMessage stack (slash router, agent
 * loop, persistence, secret scanner, …), so we test the logic against the
 * real `supportsHostProxy` predicate plus a fake Conversation.
 *
 * The second set of tests calls the real `projectSkillTools` to confirm
 * that the feature flag — not the proxy attachment — controls whether
 * `app-control` tools end up in the LLM tool list.
 */

import * as realFs from "node:fs";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { InterfaceId } from "../channels/types.js";
import { supportsHostProxy } from "../channels/types.js";
import type { SkillSummary, SkillToolManifest } from "../config/skills.js";
import { RiskLevel } from "../permissions/types.js";
import type { Tool } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Module mocks for the skill-projection layer
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

let appControlFlagEnabled = false;
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) => {
    if (key === "app-control") return appControlFlagEnabled;
    return true;
  },
  loadDefaultsRegistry: () => ({}),
}));

mock.module("../config/skill-state.js", () => ({
  skillFlagKey: (skill: { featureFlag?: string }) =>
    skill.featureFlag ?? undefined,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    skills: { entries: {}, allowBundled: null },
  }),
  loadConfig: () => ({
    skills: { entries: {}, allowBundled: null },
  }),
  invalidateConfigCache: () => {},
}));

let mockCatalog: SkillSummary[] = [];
let mockManifests: Record<string, SkillToolManifest | null> = {};
const mockRegisteredTools = new Map<string, Tool[]>();
const mockSkillRefCount = new Map<string, number>();

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => mockCatalog,
}));

mock.module("../skills/active-skill-tools.js", () => ({
  deriveActiveSkills: () => [],
}));

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
  createSkillToolsFromManifest: (
    entries: SkillToolManifest["tools"],
    skillId: string,
    _skillDir: string,
    versionHash: string,
    bundled?: boolean,
  ): Tool[] =>
    entries.map((entry) => ({
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
    })),
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
    const current = mockSkillRefCount.get(skillId) ?? 0;
    if (current > 1) {
      mockSkillRefCount.set(skillId, current - 1);
      return;
    }
    mockSkillRefCount.delete(skillId);
    mockRegisteredTools.delete(skillId);
  },
  getTool: (name: string) => {
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
    return `v1:default-hash-${parts[parts.length - 1]}`;
  },
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

const { HostAppControlProxy } =
  await import("../daemon/host-app-control-proxy.js");
const { preactivateHostProxySkills } =
  await import("../daemon/host-proxy-preactivation.js");
const { projectSkillTools, resetSkillToolProjection } =
  await import("../daemon/conversation-skill-tools.js");

// ---------------------------------------------------------------------------
// Conversation surface — captures proxy attachment + preactivations
// ---------------------------------------------------------------------------

interface FakeConversation {
  conversationId: string;
  hostAppControlProxy?: unknown;
  preactivatedSkillIds: string[];
  isProcessing(): boolean;
  setHostAppControlProxy(proxy: unknown): void;
  addPreactivatedSkillId(id: string): void;
}

function makeFakeConversation(): FakeConversation {
  const conv: FakeConversation = {
    conversationId: "conv-app-control-instantiation",
    hostAppControlProxy: undefined,
    preactivatedSkillIds: [],
    isProcessing: () => false,
    setHostAppControlProxy(proxy: unknown) {
      this.hostAppControlProxy = proxy;
    },
    addPreactivatedSkillId(id: string) {
      if (!this.preactivatedSkillIds.includes(id)) {
        this.preactivatedSkillIds.push(id);
      }
    },
  };
  return conv;
}

/**
 * Replica of the gating block from `prepareConversationForMessage`
 * (process-message.ts) and `conversation-routes.ts`. The proxy-attachment
 * step still lives inline at each call site (the proxy constructors take
 * different argument shapes), but the preactivation step routes through the
 * shared `preactivateHostProxySkills` helper exactly as the production code
 * does.
 */
function applyAppControlInstantiation(
  conv: FakeConversation,
  interfaceId: InterfaceId,
): void {
  if (supportsHostProxy(interfaceId, "host_app_control")) {
    if (!conv.isProcessing() || !conv.hostAppControlProxy) {
      conv.setHostAppControlProxy(new HostAppControlProxy(conv.conversationId));
    }
  } else if (!conv.isProcessing()) {
    conv.setHostAppControlProxy(undefined);
  }
  if (!conv.isProcessing()) {
    preactivateHostProxySkills(conv, interfaceId);
  }
}

// ---------------------------------------------------------------------------
// Skill fixtures
// ---------------------------------------------------------------------------

function makeAppControlSkill(): SkillSummary {
  return {
    id: "app-control",
    name: "app-control",
    displayName: "App Control",
    description: "Drive a specific named app via raw input",
    directoryPath: "/skills/app-control",
    skillFilePath: "/skills/app-control/SKILL.md",
    bundled: true,
    source: "bundled",
    featureFlag: "app-control",
  };
}

function makeAppControlManifest(): SkillToolManifest {
  return {
    version: 1,
    tools: [
      {
        name: "app_control_start",
        description: "Start a session against a named app",
        category: "app-control",
        risk: "medium" as const,
        input_schema: { type: "object", properties: {} },
        executor: "run.ts",
        execution_target: "host" as const,
      },
      {
        name: "app_control_observe",
        description: "Observe the focused app's window",
        category: "app-control",
        risk: "low" as const,
        input_schema: { type: "object", properties: {} },
        executor: "run.ts",
        execution_target: "host" as const,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests — proxy instantiation
// ---------------------------------------------------------------------------

describe("HostAppControlProxy instantiation gate", () => {
  beforeEach(() => {
    appControlFlagEnabled = false;
  });

  test("macOS client attaches HostAppControlProxy and preactivates app-control (flag off)", () => {
    appControlFlagEnabled = false;
    const conv = makeFakeConversation();

    applyAppControlInstantiation(conv, "macos");

    // Proxy is attached unconditionally — no flag check at instantiation.
    expect(conv.hostAppControlProxy).toBeInstanceOf(HostAppControlProxy);
    expect(conv.preactivatedSkillIds).toContain("app-control");
  });

  test("macOS client attaches HostAppControlProxy and preactivates app-control (flag on)", () => {
    appControlFlagEnabled = true;
    const conv = makeFakeConversation();

    applyAppControlInstantiation(conv, "macos");

    expect(conv.hostAppControlProxy).toBeInstanceOf(HostAppControlProxy);
    expect(conv.preactivatedSkillIds).toContain("app-control");
  });

  test("non-macOS client (slack) does not attach HostAppControlProxy nor preactivate app-control", () => {
    appControlFlagEnabled = true;
    const conv = makeFakeConversation();

    applyAppControlInstantiation(conv, "slack");

    expect(conv.hostAppControlProxy).toBeUndefined();
    expect(conv.preactivatedSkillIds).not.toContain("app-control");
  });

  test("chrome-extension client does not attach HostAppControlProxy (host_app_control unsupported)", () => {
    appControlFlagEnabled = true;
    const conv = makeFakeConversation();
    // Sanity check: chrome-extension supports host_browser, NOT host_app_control.
    expect(supportsHostProxy("chrome-extension", "host_app_control")).toBe(
      false,
    );

    applyAppControlInstantiation(conv, "chrome-extension");

    expect(conv.hostAppControlProxy).toBeUndefined();
    expect(conv.preactivatedSkillIds).not.toContain("app-control");
  });
});

// ---------------------------------------------------------------------------
// Tests — skill-projection feature-flag gating
// ---------------------------------------------------------------------------

describe("Skill projection — app-control feature-flag gating", () => {
  beforeEach(() => {
    mockCatalog = [makeAppControlSkill()];
    mockManifests = { "app-control": makeAppControlManifest() };
    mockRegisteredTools.clear();
    mockSkillRefCount.clear();
    resetSkillToolProjection();
  });

  test("flag off: app-control is filtered out of projected tools even when preactivated", () => {
    appControlFlagEnabled = false;

    const sessionState = new Map<string, string>();
    const result = projectSkillTools([], {
      preactivatedSkillIds: ["app-control"],
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.allowedToolNames.has("app_control_start")).toBe(false);
    expect(result.allowedToolNames.has("app_control_observe")).toBe(false);
  });

  test("flag on: app-control tools are projected when preactivated", () => {
    appControlFlagEnabled = true;

    const sessionState = new Map<string, string>();
    const result = projectSkillTools([], {
      preactivatedSkillIds: ["app-control"],
      previouslyActiveSkillIds: sessionState,
    });

    expect(result.allowedToolNames.has("app_control_start")).toBe(true);
    expect(result.allowedToolNames.has("app_control_observe")).toBe(true);
  });
});
