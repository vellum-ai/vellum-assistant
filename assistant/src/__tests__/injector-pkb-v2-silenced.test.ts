/**
 * v2 read-side cutover behavior for the PKB-derived default injectors.
 *
 * When `getConfig().memory.v2.enabled` is true:
 *   - `pkb-context` silences itself (concept pages own retrieval).
 *   - `pkb-reminder` still fires (its body is generic recall/remember
 *     guidance) but skips the PKB-search hints — those name PKB paths.
 *   - `now-md` fires unchanged (workspace state, independent of PKB).
 *
 * Mocks `getConfig` at the module level so each test can flip the effective
 * gate state without standing up a full config stack. Mocks the PKB hybrid
 * search so the reminder-with-hints branch can resolve deterministically
 * when called.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let v2Active = false;

const realLoader = await import("../config/loader.js");

mock.module("../config/loader.js", () => ({
  ...realLoader,
  getConfig: () => ({ memory: { v2: { enabled: v2Active } } }),
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

describe("PKB injector v2 cutover behavior", () => {
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

  test("v2 active → pkb-context silenced; pkb-reminder + now-md still fire", async () => {
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
    expect(texts.some((t) => t.includes("<system_reminder>"))).toBe(true);
    expect(texts.some((t) => t.includes("<NOW.md"))).toBe(true);
    expect(texts).toContain("What next?");
  });

  test("v2 active → pkb-reminder body fires without the hybrid-search hints", async () => {
    v2Active = true;
    const result = await applyRuntimeInjections(RUN_MESSAGES, {
      turnContext: makeTurnContext(),
      pkbActive: true,
      pkbScopeId: "scope-default",
      pkbRoot: "/tmp/pkb",
      pkbConversation: { messages: [] },
      // Provide a query vector so the v1 path WOULD have called searchPkbFiles
      // and rendered hints. Under v2, the call is skipped and the reminder
      // is rendered with empty hints — i.e. no "files look especially
      // relevant" line.
      pkbQueryVector: [0.1, 0.2, 0.3],
    });

    const texts = tailTexts(result.messages);
    const reminder = texts.find((t) => t.includes("<system_reminder>"));
    expect(reminder).toBeDefined();
    expect(reminder).not.toContain("files look especially relevant");
  });
});
