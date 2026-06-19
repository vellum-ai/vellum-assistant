import { describe, expect, test } from "bun:test";

import { CALL_SITE_DEFAULTS } from "./call-site-defaults.js";
import { resolveCallSiteConfig } from "./llm-resolver.js";
import { LLMCallSiteEnum, LLMSchema } from "./schemas/llm.js";

describe("CALL_SITE_DEFAULTS", () => {
  test("covers every LLMCallSiteEnum member", () => {
    const enumMembers = [...LLMCallSiteEnum.options].sort();
    const defaultKeys = Object.keys(CALL_SITE_DEFAULTS).sort();
    expect(defaultKeys).toEqual(enumMembers);
  });

  test("visionPerception pins the vision profile and skips thinking/cache", () => {
    expect(CALL_SITE_DEFAULTS.visionPerception).toEqual({
      profile: "vision",
      effort: "low",
      thinking: { enabled: false },
      disableCache: true,
    });
  });

  test("resolveCallSiteConfig('visionPerception') returns a config even before the vision profile exists", () => {
    // Empty config — no `vision` profile defined yet (seeded by a later PR).
    const llm = LLMSchema.parse({});
    const resolved = resolveCallSiteConfig("visionPerception", llm);

    // Falls back to the workspace default config; the call-site defaults still
    // apply on top.
    expect(resolved).toBeDefined();
    expect(resolved.effort).toBe("low");
    expect(resolved.thinking.enabled).toBe(false);
    expect(resolved.disableCache).toBe(true);
  });
});
