import { describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../__tests__/feature-flag-test-helpers.js";
import type { AssistantConfig } from "../config/schema.js";
import { isAssistantDesktopEnabled } from "./desktop-feature.js";

describe("isAssistantDesktopEnabled", () => {
  const config = {} as AssistantConfig;

  test("needs both the flag and a containerized runtime", () => {
    setOverridesForTesting({ "assistant-desktop": true });
    expect(isAssistantDesktopEnabled(config, true)).toBe(true);
    expect(isAssistantDesktopEnabled(config, false)).toBe(false);

    setOverridesForTesting({ "assistant-desktop": false });
    expect(isAssistantDesktopEnabled(config, true)).toBe(false);
  });
});
