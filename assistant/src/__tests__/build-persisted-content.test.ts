/**
 * Tests for `buildPersistedAssistantContent` stamping native web-search
 * activity (`_activityMetadata`) onto `server_tool_use` blocks at persist time.
 *
 * Native Anthropic web_search resolves mid-stream — `server_tool_complete`
 * fires before `message_complete` — so the captured activity is available when
 * the content is persisted. Unlike external provider tools, a pure-native turn
 * has no `tool_result` and never runs `annotatePersistedAssistantMessage`, so
 * stamping must happen here or the WebSearchProgressCard is lost on a history
 * reopen. Read-side coverage lives in server-history-render.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock platform (must precede imports that read it) ─────────────────────────
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    skills: {
      entries: {},
      load: { extraDirs: [], watch: false, watchDebounceMs: 0 },
      install: { nodeManager: "npm" },
      allowBundled: null,
      remoteProviders: {
        skillssh: { enabled: true },
        clawhub: { enabled: true },
      },
      remotePolicy: {
        blockSuspicious: true,
        blockMalware: true,
        maxSkillsShRisk: "medium",
      },
    },
  }),
  loadConfig: () => ({}),
}));

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessageById: () => null,
  updateMessageContent: () => {},
  provenanceFromTrustContext: () => ({}),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../memory/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import { buildPersistedAssistantContent } from "../daemon/conversation-agent-loop-handlers.js";
import type { ToolActivityMetadata } from "../daemon/message-types/web-activity.js";
import type { ContentBlock } from "../providers/types.js";

const webSearchActivity: ToolActivityMetadata = {
  webSearch: {
    query: "vellum docs",
    provider: "anthropic-native",
    resultCount: 1,
    durationMs: 88,
    results: [
      {
        rank: 1,
        title: "Vellum",
        url: "https://vellum.ai",
        domain: "vellum.ai",
      },
    ],
  },
};

function findBlockById(
  blocks: ContentBlock[],
  id: string,
): Record<string, unknown> {
  const block = (blocks as unknown as Array<Record<string, unknown>>).find(
    (b) => b.id === id,
  );
  if (!block) throw new Error(`block ${id} not found`);
  return block;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildPersistedAssistantContent — native activityMetadata", () => {
  let activity: Map<string, ToolActivityMetadata>;

  beforeEach(() => {
    activity = new Map();
  });

  test("stamps captured activity onto a pure-native server_tool_use block", () => {
    // GIVEN a turn whose only tool is a native server_tool_use whose activity
    // was captured at server_tool_complete (no external tool_result, so the
    // annotate pass never runs for this turn)
    const nativeId = "srvtu_native_search";
    activity.set(nativeId, webSearchActivity);
    const rawBlocks = [
      { type: "text", text: "Let me search." },
      {
        type: "server_tool_use",
        id: nativeId,
        name: "web_search",
        input: { query: "vellum docs" },
      },
    ] as unknown as ContentBlock[];

    // WHEN the content is built for persistence
    const built = buildPersistedAssistantContent(rawBlocks, [], activity);

    // THEN the server_tool_use block carries the native activity verbatim so it
    // survives a history reopen
    const block = findBlockById(built, nativeId);
    expect(block._activityMetadata).toEqual(webSearchActivity);
  });

  test("leaves a server_tool_use block untouched when no activity was captured", () => {
    // GIVEN a native server_tool_use with no entry in the activity map
    const nativeId = "srvtu_no_activity";
    const rawBlocks = [
      {
        type: "server_tool_use",
        id: nativeId,
        name: "web_search",
        input: { query: "vellum docs" },
      },
    ] as unknown as ContentBlock[];

    // WHEN the content is built for persistence
    const built = buildPersistedAssistantContent(rawBlocks, [], activity);

    // THEN no _activityMetadata is written
    const block = findBlockById(built, nativeId);
    expect(block._activityMetadata).toBeUndefined();
  });

  test("does not stamp external tool_use blocks (handled by the annotate pass)", () => {
    // GIVEN an external tool_use block whose id happens to have captured
    // activity (external activity is stamped later in handleToolResult, not here)
    const externalId = "tu_external_search";
    activity.set(externalId, webSearchActivity);
    const rawBlocks = [
      {
        type: "tool_use",
        id: externalId,
        name: "web_search",
        input: { query: "vellum docs" },
      },
    ] as unknown as ContentBlock[];

    // WHEN the content is built for persistence
    const built = buildPersistedAssistantContent(rawBlocks, [], activity);

    // THEN the tool_use block is left untouched by this function
    const block = findBlockById(built, externalId);
    expect(block._activityMetadata).toBeUndefined();
  });

  test("does not stamp when no activity map is provided", () => {
    // GIVEN a native server_tool_use block AND no activity map argument
    const nativeId = "srvtu_no_map";
    const rawBlocks = [
      {
        type: "server_tool_use",
        id: nativeId,
        name: "web_search",
        input: { query: "vellum docs" },
      },
    ] as unknown as ContentBlock[];

    // WHEN the content is built for persistence without the optional map
    const built = buildPersistedAssistantContent(rawBlocks, []);

    // THEN no _activityMetadata is written
    const block = findBlockById(built, nativeId);
    expect(block._activityMetadata).toBeUndefined();
  });
});
