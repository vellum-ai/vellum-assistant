import { describe, expect, test } from "bun:test";

import { CLIENT_FLAG_DEFAULTS } from "@/lib/feature-flags/feature-flag-catalog";

describe("internal-thread-actions flag keys", () => {
  // `use-client-feature-flag-sync` drops any server key the registry does not
  // declare, so both keys must stay declared for the hook's legacy fallback to
  // ever see a value.
  test("declares both the current and legacy keys as client flags", () => {
    expect(CLIENT_FLAG_DEFAULTS).toHaveProperty("internalThreadActions");
    expect(CLIENT_FLAG_DEFAULTS).toHaveProperty("forkFromMessage");
  });

  test("both keys default off", () => {
    expect(CLIENT_FLAG_DEFAULTS.internalThreadActions).toBe(false);
    expect(CLIENT_FLAG_DEFAULTS.forkFromMessage).toBe(false);
  });
});
