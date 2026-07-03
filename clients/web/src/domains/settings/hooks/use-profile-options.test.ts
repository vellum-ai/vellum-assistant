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
    extra: {},
  },
} as LlmConfig;

describe("buildProfileOptions", () => {
  test("orders by profileOrder, omits disabled profiles, and prepends Default", () => {
    expect(buildProfileOptions(llm)).toEqual([
      { value: null, label: "Default" },
      { value: "smart", label: "Smart" },
      { value: "fast", label: "Fast" },
      { value: "extra", label: "extra" },
    ]);
  });

  test("keeps the selected disabled profile visible", () => {
    expect(buildProfileOptions(llm, "legacy")).toEqual([
      { value: null, label: "Default" },
      { value: "smart", label: "Smart" },
      { value: "fast", label: "Fast" },
      { value: "legacy", label: "Legacy (Disabled)" },
      { value: "extra", label: "extra" },
    ]);
  });

  test("returns just the Default option when config is missing", () => {
    expect(buildProfileOptions(undefined)).toEqual([
      { value: null, label: "Default" },
    ]);
  });
});
