import { describe, expect, test } from "bun:test";

import { buildProfileOptions } from "@/domains/settings/hooks/use-profile-options";

import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

type LlmConfig = NonNullable<ConfigGetResponse["llm"]>;

const llm: LlmConfig = {
  profileOrder: ["smart", "fast", "legacy"],
  profiles: {
    fast: { label: "Fast" },
    smart: { label: "Smart" },
    legacy: { label: "Legacy", status: "disabled" },
    // Present in `profiles` but absent from `profileOrder`; appended last.
    extra: {},
  },
} as LlmConfig;

describe("buildProfileOptions", () => {
  test("orders by profileOrder, omits disabled, maps labels, prepends null Default", () => {
    expect(buildProfileOptions(llm)).toEqual([
      { value: null, label: "Default" },
      { value: "smart", label: "Smart" },
      { value: "fast", label: "Fast" },
      // `legacy` is disabled and dropped.
      { value: "extra", label: "extra" },
    ]);
  });

  test("falls back to the profile key when no label is set", () => {
    const config = {
      profileOrder: ["bare"],
      profiles: { bare: {} },
    } as LlmConfig;
    expect(buildProfileOptions(config)).toEqual([
      { value: null, label: "Default" },
      { value: "bare", label: "bare" },
    ]);
  });

  test("returns just the Default option when config is missing", () => {
    expect(buildProfileOptions(undefined)).toEqual([
      { value: null, label: "Default" },
    ]);
  });
});
