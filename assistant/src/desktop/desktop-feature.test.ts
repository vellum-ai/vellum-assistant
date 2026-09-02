import { describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../__tests__/feature-flag-test-helpers.js";
import type { AssistantConfig } from "../config/schema.js";
import { isPodDesktopEnabled } from "./desktop-feature.js";

describe("isPodDesktopEnabled", () => {
  const config = {} as AssistantConfig;

  test("needs both the flag and a containerized runtime", () => {
    setOverridesForTesting({ "pod-desktop": true });
    expect(isPodDesktopEnabled(config, true)).toBe(true);
    expect(isPodDesktopEnabled(config, false)).toBe(false);

    setOverridesForTesting({ "pod-desktop": false });
    expect(isPodDesktopEnabled(config, true)).toBe(false);
  });
});
