import { describe, expect, test } from "bun:test";

import { memoryTier } from "./memory-tier.js";
import type { AssistantConfig } from "./schema.js";

describe("memoryTier", () => {
  test("off when memory is explicitly disabled", () => {
    const config = { memory: { enabled: false } } as AssistantConfig;
    expect(memoryTier(config)).toBe("off");
  });

  test("off wins even when v3 is live (OFF over v3 precedence)", () => {
    const config = {
      memory: { enabled: false, v3: { live: true } },
    } as AssistantConfig;
    expect(memoryTier(config)).toBe("off");
  });

  test("v3 when memory-v3 is live", () => {
    const config = { memory: { v3: { live: true } } } as AssistantConfig;
    expect(memoryTier(config)).toBe("v3");
  });

  test("v2 when v2 is enabled and v3 is not live", () => {
    const config = {
      memory: { v2: { enabled: true }, v3: { live: false } },
    } as AssistantConfig;
    expect(memoryTier(config)).toBe("v2");
  });

  test("v3 wins over v2 when both are truthy (v3 over v2 precedence)", () => {
    const config = {
      memory: { v2: { enabled: true }, v3: { live: true } },
    } as AssistantConfig;
    expect(memoryTier(config)).toBe("v3");
  });

  test("v1 when memory is on but neither v2 nor v3 is selected", () => {
    const config = {
      memory: { enabled: true, v2: { enabled: false }, v3: { live: false } },
    } as AssistantConfig;
    expect(memoryTier(config)).toBe("v1");
  });
});
