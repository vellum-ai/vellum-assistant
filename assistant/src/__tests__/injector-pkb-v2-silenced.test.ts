/**
 * v2 read-side cutover guard for the PKB-derived default injectors.
 *
 * When `isMemoryV2ReadActive(getConfig())` is true, the three PKB-shaped
 * injectors (`pkb-context`, `pkb-reminder`, `now-md`) silence themselves so
 * the v2 activation block on the user message owns the read path
 * end-to-end. When v2 is off, they keep producing their existing blocks.
 *
 * Mocks `isMemoryV2ReadActive` at the module level so each test can flip the
 * effective gate state without standing up a full feature-flag + config
 * stack. Mocks the PKB hybrid search so the reminder-with-hints branch can
 * resolve deterministically.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let v2Active = false;

mock.module("../memory/context-search/sources/memory-v2.js", () => ({
  isMemoryV2ReadActive: () => v2Active,
}));

mock.module("../memory/pkb/pkb-search.js", () => ({
  searchPkbFiles: async () => [],
}));

const { applyRuntimeInjections } =
  await import("../daemon/conversation-runtime-assembly.js");
const { defaultInjectorsPlugin } =
  await import("../plugins/defaults/injectors.js");
const { registerPlugin, resetPluginRegistryForTests } =
  await import("../plugins/registry.js");
import type { TurnContext } from "../plugins/types.js";
import type { Message } from "../providers/types.js";

function makeTurnContext(): TurnContext {
  return {
    requestId: "req-test-1",
    conversationId: "conv-test-1",
    turnIndex: 0,
    trust: {
      sourceChannel: "vellum",
      trustClass: "guardian",
    },
  };
}

function tailTexts(messages: Message[]): string[] {
  const tail = messages[messages.length - 1];
  return tail.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text);
}

const PKB_CONTEXT = "essentials of the project";
const NOW_CONTENT = "Current focus: shipping G2.1";
const RUN_MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "What next?" }] },
];

describe("PKB injectors gated on v2 read activity", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(defaultInjectorsPlugin);
    v2Active = false;
  });

  test("v2 inactive → pkb-context, pkb-reminder, and now-md all produce blocks", async () => {
    const result = await applyRuntimeInjections(RUN_MESSAGES, {
      turnContext: makeTurnContext(),
      pkbContext: PKB_CONTEXT,
      pkbActive: true,
      pkbScopeId: "scope-default",
      pkbRoot: "/tmp/pkb",
      pkbConversation: { messages: [] },
      nowScratchpad: NOW_CONTENT,
    });

    const texts = tailTexts(result.messages);
    expect(texts.some((t) => t.includes("<knowledge_base>"))).toBe(true);
    expect(texts.some((t) => t.includes("<system_reminder>"))).toBe(true);
    expect(texts.some((t) => t.includes("<NOW.md"))).toBe(true);
  });

  test("v2 active → all three PKB injectors return null", async () => {
    v2Active = true;
    const result = await applyRuntimeInjections(RUN_MESSAGES, {
      turnContext: makeTurnContext(),
      pkbContext: PKB_CONTEXT,
      pkbActive: true,
      pkbScopeId: "scope-default",
      pkbRoot: "/tmp/pkb",
      pkbConversation: { messages: [] },
      nowScratchpad: NOW_CONTENT,
    });

    const texts = tailTexts(result.messages);
    expect(texts.some((t) => t.includes("<knowledge_base>"))).toBe(false);
    expect(texts.some((t) => t.includes("<system_reminder>"))).toBe(false);
    expect(texts.some((t) => t.includes("<NOW.md"))).toBe(false);
    // The user's typed text should still survive untouched.
    expect(texts).toContain("What next?");
  });
});
