import { describe, expect, test } from "bun:test";

import type { DaemonConfig, DaemonConfigPatch } from "@/domains/settings/ai/ai-types";
import { applyConfigPatch, snapshotPatchedFields } from "@/domains/settings/ai/ai-utils";

const BASE_CONFIG: DaemonConfig = {
  services: {
    "web-search": { mode: "your-own", provider: "perplexity" },
    "image-generation": { mode: "managed" },
  },
  llm: {
    activeProfile: "default",
    profileOrder: ["default", "fast"],
    default: { provider: "anthropic", model: "claude-sonnet" },
    profiles: {
      default: { provider: "anthropic", model: "claude-sonnet", status: "active" },
      fast: { provider: "openai", model: "gpt-4o-mini", status: "active" },
    },
    callSites: {
      "code-review": { profile: "default", provider: "anthropic", model: "claude-sonnet" },
    },
  },
};

describe("applyConfigPatch", () => {
  test("merges service fields without clobbering siblings", () => {
    const patch: DaemonConfigPatch = {
      services: { "web-search": { mode: "managed" } },
    };
    const result = applyConfigPatch(BASE_CONFIG, patch);
    expect(result.services?.["web-search"]).toEqual({
      mode: "managed",
      provider: "perplexity",
    });
    expect(result.services?.["image-generation"]).toEqual({ mode: "managed" });
  });

  test("null service entry deletes it", () => {
    const patch: DaemonConfigPatch = {
      services: { "image-generation": null },
    };
    const result = applyConfigPatch(BASE_CONFIG, patch);
    expect(result.services?.["image-generation"]).toBeUndefined();
    expect(result.services?.["web-search"]).toEqual(
      BASE_CONFIG.services?.["web-search"],
    );
  });

  test("updates activeProfile", () => {
    const patch: DaemonConfigPatch = { llm: { activeProfile: "fast" } };
    const result = applyConfigPatch(BASE_CONFIG, patch);
    expect(result.llm?.activeProfile).toBe("fast");
    expect(result.llm?.profileOrder).toEqual(["default", "fast"]);
  });

  test("replaces profileOrder", () => {
    const patch: DaemonConfigPatch = {
      llm: { profileOrder: ["fast", "default"] },
    };
    const result = applyConfigPatch(BASE_CONFIG, patch);
    expect(result.llm?.profileOrder).toEqual(["fast", "default"]);
  });

  test("null default deletes it", () => {
    const patch: DaemonConfigPatch = { llm: { default: null } };
    const result = applyConfigPatch(BASE_CONFIG, patch);
    expect(result.llm?.default).toBeUndefined();
  });

  test("merges default fields", () => {
    const patch: DaemonConfigPatch = {
      llm: { default: { model: "claude-opus" } },
    };
    const result = applyConfigPatch(BASE_CONFIG, patch);
    expect(result.llm?.default).toEqual({
      provider: "anthropic",
      model: "claude-opus",
    });
  });

  test("merges profile entry fields without clobbering siblings", () => {
    const patch: DaemonConfigPatch = {
      llm: { profiles: { default: { model: "claude-opus" } } },
    };
    const result = applyConfigPatch(BASE_CONFIG, patch);
    expect(result.llm?.profiles?.default).toEqual({
      provider: "anthropic",
      model: "claude-opus",
      status: "active",
    });
    expect(result.llm?.profiles?.fast).toEqual(
      BASE_CONFIG.llm?.profiles?.fast,
    );
  });

  test("null profile entry deletes it", () => {
    const patch: DaemonConfigPatch = {
      llm: { profiles: { fast: null } },
    };
    const result = applyConfigPatch(BASE_CONFIG, patch);
    expect(result.llm?.profiles?.fast).toBeUndefined();
    expect(result.llm?.profiles?.default).toEqual(
      BASE_CONFIG.llm?.profiles?.default,
    );
  });

  test("adds new profile entry", () => {
    const patch: DaemonConfigPatch = {
      llm: {
        profiles: { creative: { provider: "openai", model: "gpt-4o" } },
      },
    };
    const result = applyConfigPatch(BASE_CONFIG, patch);
    expect(result.llm?.profiles?.creative).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
    expect(result.llm?.profiles?.default).toEqual(
      BASE_CONFIG.llm?.profiles?.default,
    );
  });

  test("null callSite sets value to null (reset override)", () => {
    const patch: DaemonConfigPatch = {
      llm: { callSites: { "code-review": null } },
    };
    const result = applyConfigPatch(BASE_CONFIG, patch);
    expect(result.llm?.callSites?.["code-review"]).toBeNull();
  });

  test("merges callSite fields", () => {
    const patch: DaemonConfigPatch = {
      llm: { callSites: { "code-review": { model: "claude-opus" } } },
    };
    const result = applyConfigPatch(BASE_CONFIG, patch);
    expect(result.llm?.callSites?.["code-review"]).toEqual({
      profile: "default",
      provider: "anthropic",
      model: "claude-opus",
    });
  });

  test("adds new callSite override", () => {
    const patch: DaemonConfigPatch = {
      llm: {
        callSites: { "web-browse": { profile: "fast" } },
      },
    };
    const result = applyConfigPatch(BASE_CONFIG, patch);
    expect(result.llm?.callSites?.["web-browse"]).toEqual({
      profile: "fast",
    });
    expect(result.llm?.callSites?.["code-review"]).toEqual(
      BASE_CONFIG.llm?.callSites?.["code-review"],
    );
  });

  test("empty patch returns a shallow copy", () => {
    const result = applyConfigPatch(BASE_CONFIG, {});
    expect(result).toEqual(BASE_CONFIG);
    expect(result).not.toBe(BASE_CONFIG);
  });

  test("handles config with missing optional fields", () => {
    const sparse: DaemonConfig = {};
    const patch: DaemonConfigPatch = {
      services: { "web-search": { mode: "managed" } },
      llm: { activeProfile: "default" },
    };
    const result = applyConfigPatch(sparse, patch);
    expect(result.services?.["web-search"]).toEqual({ mode: "managed" });
    expect(result.llm?.activeProfile).toBe("default");
  });

  test("does not mutate the original config", () => {
    const original = structuredClone(BASE_CONFIG);
    applyConfigPatch(BASE_CONFIG, {
      services: { "web-search": { mode: "managed" } },
      llm: { profiles: { default: { model: "claude-opus" } } },
    });
    expect(BASE_CONFIG).toEqual(original);
  });
});

describe("snapshotPatchedFields", () => {
  test("snapshots only service keys touched by the patch", () => {
    const patch: DaemonConfigPatch = {
      services: { "web-search": { mode: "managed" } },
    };
    const snapshot = snapshotPatchedFields(BASE_CONFIG, patch);
    expect(snapshot.services?.["web-search"]).toEqual({
      mode: "your-own",
      provider: "perplexity",
    });
    expect(snapshot.services?.["image-generation"]).toBeUndefined();
    expect(snapshot.llm).toBeUndefined();
  });

  test("snapshots null for missing service entries", () => {
    const sparse: DaemonConfig = {};
    const patch: DaemonConfigPatch = {
      services: { "web-search": { mode: "managed" } },
    };
    const snapshot = snapshotPatchedFields(sparse, patch);
    expect(snapshot.services?.["web-search"]).toBeNull();
  });

  test("snapshots only the profile entries touched by the patch", () => {
    const patch: DaemonConfigPatch = {
      llm: { profiles: { default: { model: "claude-opus" } } },
    };
    const snapshot = snapshotPatchedFields(BASE_CONFIG, patch);
    expect(snapshot.llm?.profiles?.["default"]).toEqual(
      BASE_CONFIG.llm?.profiles?.["default"],
    );
    expect(snapshot.llm?.profiles?.["fast"]).toBeUndefined();
  });

  test("snapshots activeProfile and default independently", () => {
    const patch: DaemonConfigPatch = {
      llm: { activeProfile: "fast" },
    };
    const snapshot = snapshotPatchedFields(BASE_CONFIG, patch);
    expect(snapshot.llm?.activeProfile).toBe("default");
    expect(snapshot.llm?.default).toBeUndefined();
    expect(snapshot.llm?.profiles).toBeUndefined();
  });

  test("field-level rollback preserves concurrent mutation", () => {
    // Simulate: mutation A changes web-search, mutation B changes image-generation.
    // If A fails, rolling back A's snapshot should NOT revert B's change.
    const afterB = applyConfigPatch(BASE_CONFIG, {
      services: { "image-generation": { mode: "your-own" } },
    });
    const afterAandB = applyConfigPatch(afterB, {
      services: { "web-search": { mode: "managed" } },
    });
    // Snapshot taken BEFORE A's optimistic update (at afterB)
    const snapshotA = snapshotPatchedFields(afterB, {
      services: { "web-search": { mode: "managed" } },
    });
    // A fails — roll back only A's fields
    const rolledBack = applyConfigPatch(afterAandB, snapshotA);
    // B's change should survive
    expect(rolledBack.services?.["image-generation"]).toEqual({ mode: "your-own" });
    // A's change should be reverted
    expect(rolledBack.services?.["web-search"]).toEqual({
      mode: "your-own",
      provider: "perplexity",
    });
  });
});
