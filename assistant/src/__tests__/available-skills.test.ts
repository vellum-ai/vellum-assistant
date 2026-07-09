/**
 * Tests for `skills/available-skills.ts` — the plugin-facing skill read API.
 * Covers the host-side composition: catalog load + install-state resolution
 * (real `resolveSkillStates`) + feature-flag gating + install-meta folding,
 * and the remote-catalog projection with flag gating.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillSummary } from "../config/skills.js";
import type { SkillInstallMeta } from "../skills/install-meta.js";

function makeSummary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: "example-skill",
    name: "example-skill",
    displayName: "Example Skill",
    description: "Does an example thing",
    directoryPath: "/skills/example-skill",
    skillFilePath: "/skills/example-skill/SKILL.md",
    source: "bundled",
    ...overrides,
  };
}

let catalogFixture: SkillSummary[] = [];
let remoteFixture: unknown[] = [];
let remoteError: Error | null = null;
let installMetaByDir: Record<string, SkillInstallMeta | null> = {};
let readInstallMetaCalls: string[] = [];
let configFixture: unknown = { skills: { entries: {}, allowBundled: null } };

mock.module("../config/loader.js", () => ({
  getConfig: () => configFixture,
}));

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => catalogFixture,
}));

mock.module("../skills/install-meta.js", () => ({
  readInstallMeta: (dir: string) => {
    readInstallMetaCalls.push(dir);
    return installMetaByDir[dir] ?? null;
  },
}));

mock.module("../skills/catalog-cache.js", () => ({
  getCatalog: async () => {
    if (remoteError) {
      throw remoteError;
    }
    return remoteFixture;
  },
}));

// Deterministic flag resolution: only "on-flag" is enabled.
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (flagKey: string) => flagKey === "on-flag",
}));

beforeEach(() => {
  catalogFixture = [];
  remoteFixture = [];
  remoteError = null;
  installMetaByDir = {};
  readInstallMetaCalls = [];
  configFixture = { skills: { entries: {}, allowBundled: null } };
});

describe("listInstalledSkills", () => {
  test("maps capability fields and resolves enabled/disabled states", async () => {
    catalogFixture = [
      makeSummary({
        id: "bundled-on",
        displayName: "Bundled On",
        activationHints: ["hint-a"],
        avoidWhen: ["avoid-a"],
        alwaysCandidate: true,
      }),
      makeSummary({
        id: "managed-off",
        source: "managed",
        directoryPath: "/skills/managed-off",
      }),
    ];
    configFixture = {
      skills: {
        entries: { "managed-off": { enabled: false } },
        allowBundled: null,
      },
    };

    const { listInstalledSkills } =
      await import("../skills/available-skills.js");
    const entries = await listInstalledSkills();

    expect(entries.map((e) => e.id)).toEqual(["bundled-on", "managed-off"]);
    const bundled = entries[0]!;
    expect(bundled).toMatchObject({
      id: "bundled-on",
      displayName: "Bundled On",
      description: "Does an example thing",
      activationHints: ["hint-a"],
      avoidWhen: ["avoid-a"],
      alwaysCandidate: true,
      installed: true,
      source: "bundled",
      state: "enabled",
    });
    expect(entries[1]!.state).toBe("disabled");
  });

  test("reports flag-gated skills as unavailable instead of omitting them", async () => {
    catalogFixture = [
      makeSummary({ id: "gated", featureFlag: "off-flag" }),
      makeSummary({ id: "ungated", featureFlag: "on-flag" }),
    ];

    const { listInstalledSkills } =
      await import("../skills/available-skills.js");
    const entries = await listInstalledSkills();

    expect(entries.map((e) => [e.id, e.state])).toEqual([
      ["gated", "unavailable"],
      ["ungated", "enabled"],
    ]);
  });

  test("reports bundled skills excluded by allowBundled as unavailable", async () => {
    catalogFixture = [
      makeSummary({ id: "allowed-bundled" }),
      makeSummary({ id: "excluded-bundled" }),
    ];
    configFixture = {
      skills: { entries: {}, allowBundled: ["allowed-bundled"] },
    };

    const { listInstalledSkills } =
      await import("../skills/available-skills.js");
    const entries = await listInstalledSkills();

    expect(entries.map((e) => [e.id, e.state])).toEqual([
      ["allowed-bundled", "enabled"],
      ["excluded-bundled", "unavailable"],
    ]);
  });

  test("folds install-meta for user-installed sources only", async () => {
    const meta: SkillInstallMeta = {
      origin: "vellum",
      installedAt: "2026-01-01T00:00:00Z",
      author: "assistant",
      lastUsedAt: "2026-02-01",
    };
    catalogFixture = [
      makeSummary({
        id: "managed-skill",
        source: "managed",
        directoryPath: "/skills/managed-skill",
      }),
      makeSummary({
        id: "workspace-skill",
        source: "workspace",
        directoryPath: "/skills/workspace-skill",
      }),
      makeSummary({ id: "bundled-skill", source: "bundled" }),
      makeSummary({ id: "plugin-skill", source: "plugin" }),
    ];
    installMetaByDir = { "/skills/managed-skill": meta };

    const { listInstalledSkills } =
      await import("../skills/available-skills.js");
    const entries = await listInstalledSkills();
    const byId = new Map(entries.map((e) => [e.id, e]));

    expect(byId.get("managed-skill")!.installMeta).toEqual(meta);
    // Read but absent on disk → null.
    expect(byId.get("workspace-skill")!.installMeta).toBeNull();
    // Never read for sources that don't carry install-meta.
    expect(byId.get("bundled-skill")!.installMeta).toBeUndefined();
    expect(byId.get("plugin-skill")!.installMeta).toBeUndefined();
    expect(readInstallMetaCalls.sort()).toEqual([
      "/skills/managed-skill",
      "/skills/workspace-skill",
    ]);
  });
});

describe("listCatalogSkills", () => {
  test("projects vellum metadata with name fallback and flag gating", async () => {
    remoteFixture = [
      {
        id: "rich-skill",
        name: "rich-skill",
        description: "Remote skill with metadata",
        metadata: {
          vellum: {
            "display-name": "Rich Skill",
            "activation-hints": ["when remote"],
            "avoid-when": ["when local"],
            "feature-flag": "on-flag",
          },
        },
      },
      {
        id: "bare-skill",
        name: "bare-skill",
        description: "Remote skill without metadata",
      },
      {
        id: "gated-skill",
        name: "gated-skill",
        description: "Remote skill behind a disabled flag",
        metadata: { vellum: { "feature-flag": "off-flag" } },
      },
    ];

    const { listCatalogSkills } = await import("../skills/available-skills.js");
    const entries = await listCatalogSkills();

    expect(entries).toEqual([
      {
        id: "rich-skill",
        displayName: "Rich Skill",
        description: "Remote skill with metadata",
        activationHints: ["when remote"],
        avoidWhen: ["when local"],
        installed: false,
        state: "available",
      },
      {
        id: "bare-skill",
        displayName: "bare-skill",
        description: "Remote skill without metadata",
        activationHints: undefined,
        avoidWhen: undefined,
        installed: false,
        state: "available",
      },
      {
        id: "gated-skill",
        displayName: "gated-skill",
        description: "Remote skill behind a disabled flag",
        activationHints: undefined,
        avoidWhen: undefined,
        installed: false,
        state: "unavailable",
      },
    ]);
  });

  test("returns an empty array for an empty catalog", async () => {
    remoteFixture = [];
    const { listCatalogSkills } = await import("../skills/available-skills.js");
    expect(await listCatalogSkills()).toEqual([]);
  });

  test("propagates catalog fetch failures to the caller", async () => {
    remoteError = new Error("catalog unreachable");
    const { listCatalogSkills } = await import("../skills/available-skills.js");
    expect(listCatalogSkills()).rejects.toThrow("catalog unreachable");
  });
});
