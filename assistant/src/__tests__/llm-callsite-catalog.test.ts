import { describe, expect, test } from "bun:test";

import { getLLMCallSiteLabel } from "../config/llm-callsite-catalog.js";
import { CALL_SITE_CATALOG } from "../config/schemas/call-site-catalog.js";
import { LLMCallSiteEnum } from "../config/schemas/llm.js";

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
});
