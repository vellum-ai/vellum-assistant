// End-to-end integration coverage for the centralized web_search
// backend-failure normalization layer (ATL-727).
//
// PRs 1-4 built the layer in three places:
//   - `tools/network/web-search-error.ts` — `classifyWebSearchFailure` +
//     `WEB_SEARCH_BACKEND_FAILURE_MESSAGE` + the structured
//     `web_search_backend_failure` log helper.
//   - `daemon/conversation-agent-loop-handlers.ts` — the native
//     `server_tool_complete` handler maps Anthropic backend failures to the
//     friendly copy, dedups per turn (`webSearchBackendFailureNotified`), and
//     gates telemetry on `classification.isBackendFailure`.
//   - `tools/network/web-search.ts` — the app-side `backendFailureResult`
//     helper routes 5xx/network/429 to the same copy.
//
// The single-layer native-handler invariants (friendly copy + isError + empty
// results, raw-detail-logged-not-shown, per-turn dedup, successful-empty
// search) are owned by `native-web-search.test.ts`. This file locks the
// cross-cutting acceptance criteria that file does not cover:
//   - honest continuation (the failure is a recoverable tool_result, not a
//     thrown provider error; the search is never marked successful),
//   - web_fetch DNS failures are NOT conflated with the search backend copy.
//
// It genuinely reuses the shared handler harness in
// `helpers/native-web-search-harness.ts` (the same harness driven by
// `native-web-search.test.ts`); the web_fetch invariant is exercised through
// the same `handleToolResult` path an app-executed fetch tool drives.

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolActivityMetadata } from "../daemon/message-types/web-activity.js";

// ---------------------------------------------------------------------------
// Mock the daemon collaborators the handler module imports at load time so the
// handler can be driven in isolation (mirrors native-web-search.test.ts).
// `mock.module()` is file-scoped, so the shared harness cannot install these.
// ---------------------------------------------------------------------------

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

// Import after mocking.
import {
  createEventHandlerState,
  dispatchAgentEvent,
  type EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import { WEB_SEARCH_BACKEND_FAILURE_MESSAGE } from "../tools/network/web-search-error.js";
import {
  backendFailureLogs,
  completeNativeWebSearch,
  createHandlerDeps,
  lastToolResult,
} from "./helpers/native-web-search-harness.js";

describe("web_search backend-failure end-to-end (ATL-727)", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    state = createEventHandlerState();
  });

  test("backend failure stays an honest, recoverable tool result (not a thrown provider error, never marked successful)", async () => {
    const { deps, events } = createHandlerDeps("req-honesty");

    // A recoverable backend failure flows as a tool_result, so dispatch must
    // resolve without throwing.
    await expect(
      completeNativeWebSearch(state, deps, "tu_honesty", {
        isError: true,
        errorCode: "unavailable",
      }),
    ).resolves.toBeUndefined();

    const result = lastToolResult(events);
    // The search is never silently upgraded to a success.
    expect(result?.isError).toBe(true);
    expect(result?.activityMetadata?.webSearch?.resultCount).toBe(0);
    expect(result?.activityMetadata?.webSearch?.results).toEqual([]);
  });

  test("web_fetch DNS failure is NOT conflated with the web_search backend copy", async () => {
    // The normalization layer keys exclusively on web_search (the native
    // `server_tool_complete` handler and `web-search.ts`). It never inspects
    // `webFetch` metadata. handleToolResult forwards an app-executed tool's
    // `activityMetadata` verbatim, so a web_fetch DNS failure must reach the
    // client with its own copy and acquire NO `webSearch` metadata. Drive that
    // path directly with a DNS-failure fetch result for grimgoods.io.
    const { deps, events, warnings } = createHandlerDeps("req-web-fetch");

    const dnsError =
      'Error: Unable to resolve host "grimgoods.io" (DNS lookup failed)';
    const fetchMetadata: ToolActivityMetadata = {
      webFetch: {
        url: "https://grimgoods.io",
        finalUrl: "https://grimgoods.io",
        status: 0,
        byteCount: 0,
        charCount: 0,
        truncated: false,
        domain: "grimgoods.io",
        redirectCount: 0,
        durationMs: 12,
        errorMessage: dnsError,
      },
    };

    await dispatchAgentEvent(state, deps, {
      type: "tool_use",
      id: "tu_fetch",
      name: "web_fetch",
      input: { url: "https://grimgoods.io" },
    });
    await dispatchAgentEvent(state, deps, {
      type: "tool_result",
      toolUseId: "tu_fetch",
      content: dnsError,
      isError: true,
      activityMetadata: fetchMetadata,
    });

    const result = lastToolResult(events);
    expect(result?.isError).toBe(true);

    // The DNS error keeps its own webFetch copy untouched...
    expect(result?.activityMetadata?.webFetch?.errorMessage).toBe(dnsError);
    // ...and is never rewritten to the search backend copy.
    expect(result?.activityMetadata?.webFetch?.errorMessage).not.toBe(
      WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
    );
    // No webSearch metadata is fabricated for a fetch failure.
    expect(result?.activityMetadata?.webSearch).toBeUndefined();
    // And the web_search backend-failure telemetry never fires for a fetch.
    expect(backendFailureLogs(warnings)).toHaveLength(0);
  });
});
