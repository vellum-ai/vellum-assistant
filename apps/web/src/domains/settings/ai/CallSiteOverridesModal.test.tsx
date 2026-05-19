import { describe, expect, test } from "bun:test";

import {
  CUSTOM_SENTINEL,
  type CallSiteOverrideDraft,
} from "@/domains/settings/ai/CallSiteOverridesModal.js";

describe("CallSiteOverridesModal", () => {
  test("CUSTOM_SENTINEL is underscore-prefixed — not a real profile name", () => {
    expect(CUSTOM_SENTINEL.startsWith("__")).toBe(true);
  });
});

describe("CallSiteOverrideDraft helpers", () => {
  function isDraftActive(d: CallSiteOverrideDraft | null | undefined): boolean {
    if (!d) return false;
    return !!(d.profile || d.provider || d.model);
  }

  function draftsEqual(
    a: CallSiteOverrideDraft | null | undefined,
    b: CallSiteOverrideDraft | null | undefined,
  ): boolean {
    const aActive = isDraftActive(a);
    const bActive = isDraftActive(b);
    if (aActive !== bActive) return false;
    if (!aActive) return true;
    return (
      (a?.profile ?? null) === (b?.profile ?? null) &&
      (a?.provider ?? null) === (b?.provider ?? null) &&
      (a?.model ?? null) === (b?.model ?? null)
    );
  }

  test("isDraftActive returns false for null or empty draft", () => {
    expect(isDraftActive(null)).toBe(false);
    expect(isDraftActive(undefined)).toBe(false);
    expect(isDraftActive({})).toBe(false);
    expect(isDraftActive({ profile: null, provider: null, model: null })).toBe(false);
  });

  test("isDraftActive returns true when any field is set", () => {
    expect(isDraftActive({ profile: "fast" })).toBe(true);
    expect(isDraftActive({ provider: "anthropic" })).toBe(true);
    expect(isDraftActive({ model: "claude-sonnet-4-6" })).toBe(true);
  });

  test("draftsEqual treats two inactive drafts as equal", () => {
    expect(draftsEqual(null, null)).toBe(true);
    expect(draftsEqual(null, {})).toBe(true);
    expect(draftsEqual({ profile: null }, null)).toBe(true);
  });

  test("draftsEqual treats null and undefined fields as equal (both mean not set)", () => {
    expect(
      draftsEqual({ profile: "fast", provider: null }, { profile: "fast", provider: undefined }),
    ).toBe(true);
    expect(
      draftsEqual({ profile: "fast", model: undefined }, { profile: "fast", model: null }),
    ).toBe(true);
  });

  test("draftsEqual detects a change from inactive to active", () => {
    expect(draftsEqual(null, { profile: "fast" })).toBe(false);
    expect(draftsEqual({ profile: "fast" }, null)).toBe(false);
  });

  test("draftsEqual detects field-level changes", () => {
    expect(
      draftsEqual({ profile: "fast" }, { profile: "precise" }),
    ).toBe(false);
    expect(
      draftsEqual({ provider: "anthropic", model: "a" }, { provider: "openai", model: "a" }),
    ).toBe(false);
    expect(
      draftsEqual(
        { provider: "anthropic", model: "a" },
        { provider: "anthropic", model: "a" },
      ),
    ).toBe(true);
  });

  test("hasUnsavedDrafts detects draft that differs from persisted (excludes mainAgent)", () => {
    function hasUnsavedDrafts(
      drafts: Record<string, CallSiteOverrideDraft | null>,
      persisted: Record<string, CallSiteOverrideDraft | null | undefined>,
    ): boolean {
      const allIds = new Set([...Object.keys(drafts), ...Object.keys(persisted)]);
      for (const id of allIds) {
        if (id === "mainAgent") continue;
        if (!draftsEqual(drafts[id], persisted[id])) return true;
      }
      return false;
    }

    expect(
      hasUnsavedDrafts(
        { mainAgent: { profile: "precise" } },
        { mainAgent: { profile: "fast" } },
      ),
    ).toBe(false);

    expect(
      hasUnsavedDrafts(
        { mainAgent: { profile: "precise" }, sidebar: { profile: "fast" } },
        { mainAgent: { profile: "fast" }, sidebar: null },
      ),
    ).toBe(true);
  });

  test("hasAnyPersistedOverride excludes mainAgent", () => {
    function hasAnyPersistedOverride(
      persisted: Record<string, CallSiteOverrideDraft | null | undefined>,
    ): boolean {
      return Object.entries(persisted).some(
        ([id, s]) =>
          id !== "mainAgent" &&
          (s?.profile != null || s?.provider != null || s?.model != null),
      );
    }

    expect(
      hasAnyPersistedOverride({ mainAgent: { provider: "openai", model: "gpt-5.5" } }),
    ).toBe(false);

    expect(
      hasAnyPersistedOverride({
        mainAgent: { provider: "openai", model: "gpt-5.5" },
        sidebar: { profile: "fast" },
      }),
    ).toBe(true);
  });

  test("validation error exists when provider is set but model is empty", () => {
    const drafts: Record<string, CallSiteOverrideDraft | null> = {
      mainAgent: { provider: "anthropic", model: "" },
    };
    const hasError = Object.values(drafts).some(
      (d) => isDraftActive(d) && !!d?.provider && !d?.model,
    );
    expect(hasError).toBe(true);
  });

  test("no validation error when both provider and model are set", () => {
    const drafts: Record<string, CallSiteOverrideDraft | null> = {
      mainAgent: { provider: "anthropic", model: "claude-sonnet-4-6" },
    };
    const hasError = Object.values(drafts).some(
      (d) => isDraftActive(d) && !!d?.provider && !d?.model,
    );
    expect(hasError).toBe(false);
  });
});
