import { describe, expect, test } from "bun:test";

import { buildProfileOptions } from "@/domains/settings/hooks/use-profile-options";

import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

type LlmConfig = NonNullable<ConfigGetResponse["llm"]>;

const llm: LlmConfig = {
  profileOrder: ["smart", "fast", "legacy"],
  profiles: {
    fast: { label: "Fast", provider: "anthropic", model: "claude-fable-5" },
    smart: { label: "Smart", provider: "anthropic", model: "claude-opus-5" },
    legacy: {
      label: "Legacy",
      status: "disabled",
      provider: "anthropic",
      model: "claude-opus-5",
    },
    // Carries nothing to dispatch with. The resolver skips such a rung, so
    // offering it would produce a selection that silently does nothing.
    extra: {},
  },
} as LlmConfig;

describe("buildProfileOptions", () => {
  test("orders by profileOrder, omits what the resolver would skip, and prepends Default", () => {
    expect(buildProfileOptions(llm)).toEqual([
      { value: null, label: "Default" },
      { value: "smart", label: "Smart" },
      { value: "fast", label: "Fast" },
    ]);
  });

  test("keeps the selected disabled profile visible", () => {
    expect(buildProfileOptions(llm, "legacy")).toEqual([
      { value: null, label: "Default" },
      { value: "smart", label: "Smart" },
      { value: "fast", label: "Fast" },
      { value: "legacy", label: "Legacy (Disabled)", issue: "disabled" },
    ]);
  });

  // Hiding the current selection would leave the trigger blank with no way
  // back, so it stays and is flagged instead.
  test("keeps a selected undispatchable profile visible and marks the issue", () => {
    expect(buildProfileOptions(llm, "extra")).toEqual([
      { value: null, label: "Default" },
      { value: "smart", label: "Smart" },
      { value: "fast", label: "Fast" },
      {
        value: "extra",
        label: "extra",
        issue: "undispatchable",
        reason: expect.stringContaining("cannot be used"),
      },
    ]);
  });

  test("returns just the Default option when config is missing", () => {
    expect(buildProfileOptions(undefined)).toEqual([
      { value: null, label: "Default" },
    ]);
  });
});
