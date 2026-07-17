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

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessageById: () => null,
  updateMessageContent: () => {},
  provenanceFromTrustContext: () => ({}),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import { REDACTED_SENTINEL_OPEN } from "@vellumai/service-contracts/redacted-credential";

import type { ResolvedRevealCandidate } from "../daemon/chat-credential-redaction.js";
import {
  buildPersistedAssistantContent,
  stampThinkingTiming,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ToolActivityMetadata } from "../daemon/message-types/web-activity.js";
import type { ContentBlock } from "../providers/types.js";
import {
  OPENAI_PROJECT_KEY_REDACTION_MARKER,
  SYNTHETIC_OPAQUE_CREDENTIAL,
  SYNTHETIC_OPENAI_PROJECT_KEY,
} from "./secret-fixtures.js";

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

describe("stampThinkingTiming", () => {
  test("stamps internal timing onto thinking blocks by position", () => {
    // GIVEN a turn that interleaves text and two thinking blocks AND the
    // per-block timing captured while streaming (one entry per thinking block,
    // in stream order)
    const content = [
      { type: "thinking", thinking: "first", signature: "s1" },
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "second", signature: "s2" },
    ] as unknown as ContentBlock[];
    const timings = [
      { startedAt: 100, completedAt: 250 },
      { startedAt: 400, completedAt: 480 },
    ];

    // WHEN the content is stamped before persistence
    const stamped = stampThinkingTiming(content, timings) as unknown as Array<
      Record<string, unknown>
    >;

    // THEN each thinking block carries the `_`-prefixed timing for its position
    expect(stamped[0]).toMatchObject({
      type: "thinking",
      _startedAt: 100,
      _completedAt: 250,
    });
    expect(stamped[2]).toMatchObject({
      type: "thinking",
      _startedAt: 400,
      _completedAt: 480,
    });
    // AND the interleaved text block is left untouched
    expect(stamped[1]).toEqual({ type: "text", text: "answer" });
  });

  test("leaves thinking blocks unstamped when no timing was captured", () => {
    // GIVEN thinking content but an empty timing list (thinking streaming was
    // disabled, so no per-block timing was recorded this turn)
    const content = [
      { type: "thinking", thinking: "first", signature: "s1" },
    ] as unknown as ContentBlock[];

    // WHEN the content is stamped with no timing
    const stamped = stampThinkingTiming(content, []);

    // THEN the original content is returned unchanged so the UI hides duration,
    // exactly as a tool call with no timing
    expect(stamped).toBe(content);
    expect(stamped[0]).not.toHaveProperty("_startedAt");
  });

  test("stamps only the thinking blocks that have a matching timing entry", () => {
    // GIVEN two thinking blocks but only one captured timing entry (e.g. the
    // second block opened after the timing array was already finalized)
    const content = [
      { type: "thinking", thinking: "first", signature: "s1" },
      { type: "thinking", thinking: "second", signature: "s2" },
    ] as unknown as ContentBlock[];
    const timings = [{ startedAt: 100, completedAt: 250 }];

    // WHEN the content is stamped
    const stamped = stampThinkingTiming(content, timings) as unknown as Array<
      Record<string, unknown>
    >;

    // THEN the first block is stamped and the unmatched second block is left as-is
    expect(stamped[0]).toMatchObject({ _startedAt: 100, _completedAt: 250 });
    expect(stamped[1]).not.toHaveProperty("_startedAt");
  });
});

/**
 * The `chat-credential-reveal` gate lives one layer up in
 * `chatRevealCandidates`, which yields `undefined` when the flag is off — so
 * `revealCandidates: undefined` here is the flag-off persist path, and the
 * default configuration. Redaction is not what the flag selects: a
 * route-proven reveal plaintext must stay out of the persisted row in both
 * modes, via the flag-independent `legacyFallbackCandidates` seam.
 */
describe("buildPersistedAssistantContent — legacy (flag-off) redaction", () => {
  const openaiCandidate: ResolvedRevealCandidate = {
    service: "openai",
    field: "api_key",
    value: SYNTHETIC_OPENAI_PROJECT_KEY,
  };
  const opaqueCandidate: ResolvedRevealCandidate = {
    service: "acme",
    field: "token",
    value: SYNTHETIC_OPAQUE_CREDENTIAL,
  };

  function persistText(
    text: string,
    revealCandidates?: readonly ResolvedRevealCandidate[],
    legacyFallbackCandidates: readonly ResolvedRevealCandidate[] = [],
  ): string {
    const built = buildPersistedAssistantContent(
      [{ type: "text", text }] as unknown as ContentBlock[],
      [],
      undefined,
      revealCandidates,
      legacyFallbackCandidates,
    ) as unknown as Array<Record<string, unknown>>;
    return built[0].text as string;
  }

  test("emits the legacy marker for a scanner match, never sentinel glyphs", () => {
    const out = persistText(`key: ${SYNTHETIC_OPENAI_PROJECT_KEY}`);

    expect(out).toBe(`key: ${OPENAI_PROJECT_KEY_REDACTION_MARKER}`);
    expect(out).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
    expect(out).not.toContain(REDACTED_SENTINEL_OPEN);
  });

  test("redacts a proven candidate the scanner cannot classify", () => {
    // The opaque value has no scanner-recognizable shape, so the fallback is
    // the only thing standing between it and a raw persisted row.
    const out = persistText(
      `token: ${SYNTHETIC_OPAQUE_CREDENTIAL}`,
      undefined,
      [opaqueCandidate],
    );

    expect(out).not.toContain(SYNTHETIC_OPAQUE_CREDENTIAL);
    expect(out).toContain("<redacted");
    expect(out).not.toContain(REDACTED_SENTINEL_OPEN);
  });

  test("marks the block neutralization-aware in legacy mode too", () => {
    // `renderHistoryContent` neutralizes any block lacking the rider, so a
    // legacy-mode row must still carry it or its own text gets re-scanned.
    const built = buildPersistedAssistantContent(
      [{ type: "text", text: "no secrets here" }] as unknown as ContentBlock[],
      [],
    ) as unknown as Array<Record<string, unknown>>;

    expect(built[0]._redactionVersion).toBe(2);
  });

  test("sentinel mode enriches the same candidate the legacy path flattens", () => {
    // Candidate spans are protected ahead of the scanner in both modes, so the
    // legacy marker reports the generic type while the sentinel carries the
    // vault identity the chip needs.
    const legacy = persistText(
      `key: ${SYNTHETIC_OPENAI_PROJECT_KEY}`,
      undefined,
      [openaiCandidate],
    );
    const sentinel = persistText(`key: ${SYNTHETIC_OPENAI_PROJECT_KEY}`, [
      openaiCandidate,
    ]);

    expect(legacy).toBe('key: <redacted type="Credential" />');
    expect(sentinel).toBe(
      "key: 〔redacted:OpenAI Project Key:openai:api_key〕",
    );
  });
});
