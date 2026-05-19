import { describe, expect, test } from "bun:test";

import { CALL_SITE_DEFAULTS } from "../config/call-site-defaults.js";
import { getLLMCallSiteLabel } from "../config/llm-callsite-catalog.js";
import { CALL_SITE_CATALOG } from "../config/schemas/call-site-catalog.js";
import { LLMCallSiteEnum, LLMSchema } from "../config/schemas/llm.js";

describe("LLM call-site catalog", () => {
  test("resolves every backend call-site enum value from the catalog", () => {
    const catalogIds = new Set(CALL_SITE_CATALOG.map(({ id }) => id));

    expect(LLMCallSiteEnum.options.filter((id) => !catalogIds.has(id))).toEqual(
      [],
    );
  });

  test("returns catalog display names", () => {
    for (const { id, displayName } of CALL_SITE_CATALOG) {
      expect(getLLMCallSiteLabel(id)).toBe(displayName);
    }
  });

  test("returns canonical user-facing labels", () => {
    expect(getLLMCallSiteLabel("mainAgent")).toBe("Main Agent");
    expect(getLLMCallSiteLabel("memoryExtraction")).toBe("Memory Extraction");
    expect(getLLMCallSiteLabel("conversationTitle")).toBe("Conversation Title");
    expect(getLLMCallSiteLabel("trustRuleSuggestion")).toBe(
      "Trust Rule Suggestion",
    );
  });

  test("returns the raw ID for unknown call sites", () => {
    expect(getLLMCallSiteLabel("unknownCallSite")).toBe("unknownCallSite");
  });

  test("registers the memoryRouter call site under the memory domain", () => {
    expect(LLMCallSiteEnum.options).toContain("memoryRouter");

    const entry = CALL_SITE_CATALOG.find(({ id }) => id === "memoryRouter");
    expect(entry).toBeDefined();
    expect(entry?.domain).toBe("memory");
    expect(entry?.displayName).toBe("Memory Router");
    expect(entry?.description).toBe(
      "Selects which concept pages to inject for the next agent turn by routing over a cached page index.",
    );
  });

  test("memoryRouter is addressable as a call-site override key in LLMSchema", () => {
    const parsed = LLMSchema.parse({
      callSites: { memoryRouter: { model: "claude-sonnet-4-6" } },
    });
    expect(parsed.callSites.memoryRouter?.model).toBe("claude-sonnet-4-6");
  });

  test("CALL_SITE_DEFAULTS covers every LLMCallSite enum value", () => {
    const defaultIds = new Set(Object.keys(CALL_SITE_DEFAULTS));
    const missing = LLMCallSiteEnum.options.filter(
      (id) => !defaultIds.has(id),
    );
    expect(missing).toEqual([]);
  });

  test("CALL_SITE_DEFAULTS contains no unknown call-site keys", () => {
    const enumIds = new Set<string>(LLMCallSiteEnum.options);
    const extra = Object.keys(CALL_SITE_DEFAULTS).filter(
      (id) => !enumIds.has(id),
    );
    expect(extra).toEqual([]);
  });

  test("every CALL_SITE_DEFAULTS entry has a profile field", () => {
    for (const [, config] of Object.entries(CALL_SITE_DEFAULTS)) {
      expect(config.profile).toBeDefined();
      expect(typeof config.profile).toBe("string");
      expect(config.profile!.length).toBeGreaterThan(0);
    }
  });
});
