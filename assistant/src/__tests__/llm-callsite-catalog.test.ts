import { describe, expect, test } from "bun:test";

import {
  getLLMCallSiteLabel,
  LLM_CALLSITE_CATALOG,
} from "../config/llm-callsite-catalog.js";
import { LLMCallSiteEnum } from "../config/schemas/llm.js";

describe("LLM call-site catalog", () => {
  test("has a label for every backend call-site enum value", () => {
    const missing = LLMCallSiteEnum.options.filter(
      (callSite) => LLM_CALLSITE_CATALOG[callSite] === undefined,
    );
    expect(missing).toEqual([]);
  });

  test("returns canonical user-facing labels", () => {
    expect(getLLMCallSiteLabel("mainAgent")).toBe("Main agent");
    expect(getLLMCallSiteLabel("memoryExtraction")).toBe("Memory extraction");
    expect(getLLMCallSiteLabel("conversationTitle")).toBe("Conversation title");
    expect(getLLMCallSiteLabel("trustRuleSuggestion")).toBe(
      "Trust rule suggestion",
    );
  });
});
