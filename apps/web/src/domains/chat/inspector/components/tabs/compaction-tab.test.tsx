/**
 * Tests for the CompactionTab component.
 *
 * Strategy mirrors `inspect-page.test.tsx`: render to static markup
 * (no DOM), mock the hook at the module boundary so each branch
 * (loading / error / empty / populated) can be exercised in
 * isolation.
 *
 * Interactive behavior (the Show/Hide summary text toggle) is not
 * covered here — `useState` doesn't run under `renderToStaticMarkup`.
 * Catch any regression there with the playwright-class harness when
 * it lands.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { CompactionTrailEvent } from "../../compaction-trail-fetch";
import type { LLMRequestLogEntry } from "@vellumai/assistant-api";

interface HookState {
  data: { conversationId: string; events: CompactionTrailEvent[] } | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

let hookStub: HookState = {
  data: undefined,
  isLoading: true,
  isError: false,
  error: null,
  refetch: () => {},
};

const hookCallArgs: Array<{
  assistantId: string | undefined;
  conversationId: string | undefined;
  callId: string | undefined;
}> = [];

mock.module("@/domains/chat/inspector/compaction-trail-api", () => ({
  useCompactionTrail: (
    assistantId: string | undefined,
    conversationId: string | undefined,
    callId: string | undefined,
  ) => {
    hookCallArgs.push({ assistantId, conversationId, callId });
    return hookStub;
  },
}));

// Imported AFTER the mock so the component picks up the stub.
import { CompactionTab } from "./compaction-tab";

function makeEntry(overrides: Partial<LLMRequestLogEntry> = {}): LLMRequestLogEntry {
  return {
    id: "call-test-1",
    createdAt: Date.parse("2026-05-26T13:30:00Z"),
    requestPayload: null,
    responsePayload: null,
    ...overrides,
  };
}

function render(entry: LLMRequestLogEntry = makeEntry()): string {
  return renderToStaticMarkup(
    <CompactionTab
      assistantId="asst-1"
      conversationId="conv-1"
      entry={entry}
    />,
  );
}

function makeEvent(
  overrides: Partial<CompactionTrailEvent> = {},
): CompactionTrailEvent {
  return {
    id: "compaction-test-1",
    createdAt: Date.parse("2026-05-26T12:00:00Z"),
    trigger: "budget",
    compacted: true,
    summaryFailed: false,
    skipReason: null,
    contextTokensBefore: 180_000,
    contextTokensAfter: 60_000,
    messagesBefore: 120,
    messagesAfter: 12,
    compactedMessages: 108,
    preservedTailMessages: 12,
    durationMs: 8_000,
    summaryModel: "claude-sonnet-4-5",
    summaryInputTokens: 3,
    summaryOutputTokens: 882,
    summaryText: "Summary text for the test event.",
    ...overrides,
  };
}

function populated(events: CompactionTrailEvent[]): HookState {
  return {
    data: { conversationId: "conv-1", events },
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => {},
  };
}

beforeEach(() => {
  hookStub = {
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
    refetch: () => {},
  };
  hookCallArgs.length = 0;
});

describe("CompactionTab — loading state", () => {
  test("renders a loading message while the query is in flight", () => {
    /** The in-flight query renders the loading placeholder. */
    // GIVEN the hook reports the query is still loading (the default stub)
    // WHEN the tab renders
    const html = render();
    // THEN it shows the loading placeholder
    expect(html).toContain("Loading compaction");
  });
});

describe("CompactionTab — error state", () => {
  test("surfaces the underlying error message and a retry control", () => {
    /** A failed query surfaces the error message and a retry button. */
    // GIVEN the hook reports an error
    hookStub = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("daemon offline"),
      refetch: () => {},
    };
    // WHEN the tab renders
    const html = render();
    // THEN it shows the failure heading, the error message, and a retry control
    expect(html).toContain("Failed to load");
    expect(html).toContain("daemon offline");
    expect(html).toContain("Retry");
  });
});

describe("CompactionTab — empty state", () => {
  test("renders the call-scoped empty-state copy when no events are returned", () => {
    /** No attributed compaction renders the call-scoped empty copy. */
    // GIVEN the hook returns an empty event list
    hookStub = populated([]);
    // WHEN the tab renders
    const html = render();
    // THEN it explains that no compaction is tied to this call
    expect(html).toContain("No compaction is tied to this call");
  });
});

describe("CompactionTab — populated state", () => {
  test("renders the context-token and message reduction for a compaction", () => {
    /**
     * The headline numbers are the context reduction (before → after),
     * not the summarizer call's own usage.
     */
    // GIVEN a completed compaction that shrank the context window
    hookStub = populated([makeEvent()]);
    // WHEN the tab renders
    const html = render();
    // THEN the context-token row shows before → after
    expect(html).toContain("180,000");
    expect(html).toContain("60,000");
    // AND the message-count row shows before → after
    expect(html).toContain("120");
    expect(html).toContain("12");
    // AND the success outcome label is shown
    expect(html).toContain("Compacted");
  });

  test("shows the summarizer's own token usage separately from the context reduction", () => {
    /**
     * Regression for the `3 → 882` bug: the summarizer call's own
     * usage must render on its own row, never as the context tokens.
     */
    // GIVEN a compaction whose summarizer call used 3 in / 882 out
    hookStub = populated([
      makeEvent({
        contextTokensBefore: 180_000,
        contextTokensAfter: 60_000,
        summaryInputTokens: 3,
        summaryOutputTokens: 882,
      }),
    ]);
    // WHEN the tab renders
    const html = render();
    // THEN the summarizer usage appears on the summary-cost row
    expect(html).toContain("3 in / 882 out");
    // AND the context row is the reduction, not 3 → 882
    expect(html).toContain("180,000");
    expect(html).toContain("60,000");
  });

  test("renders a reduction ratio next to the context-token row", () => {
    /** A meaningful shrink annotates the context row with a ratio. */
    // GIVEN a compaction from 200,000 down to 5,000 context tokens
    hookStub = populated([
      makeEvent({ contextTokensBefore: 200_000, contextTokensAfter: 5_000 }),
    ]);
    // WHEN the tab renders
    const html = render();
    // THEN the 40× reduction is annotated
    expect(html).toContain("40× smaller");
  });

  test("labels a failed summarizer call as a failed compaction", () => {
    /** `summaryFailed` drives the failure outcome, not a stop reason. */
    // GIVEN a compaction whose summarizer call errored
    hookStub = populated([
      makeEvent({ summaryFailed: true, compacted: false }),
    ]);
    // WHEN the tab renders
    const html = render();
    // THEN it is labeled as a failed compaction
    expect(html).toContain("Compaction failed");
  });

  test("labels a no-op compaction as no change with its skip reason", () => {
    /** A completed-but-not-compacted run reports the skip reason. */
    // GIVEN a run that completed without compacting
    hookStub = populated([
      makeEvent({
        compacted: false,
        summaryFailed: false,
        skipReason: "under-threshold",
      }),
    ]);
    // WHEN the tab renders
    const html = render();
    // THEN it is labeled "No change" and surfaces the skip reason
    expect(html).toContain("No change");
    expect(html).toContain("under-threshold");
  });

  test("labels a legacy-fallback event with unrecoverable flags as unavailable", () => {
    /**
     * The `llm_request_logs` fallback leaves the outcome flags null even
     * though the row exists only for a compaction that produced a summary,
     * so the outcome is reported as unavailable, not as a failed/incomplete
     * run that never recorded a result.
     */
    // GIVEN a legacy-projected event whose outcome flags are all null
    hookStub = populated([
      makeEvent({
        compacted: null,
        summaryFailed: null,
        skipReason: null,
        summaryModel: "summary-model",
        summaryText: "Recovered summary.",
      }),
    ]);
    // WHEN the tab renders
    const html = render();
    // THEN it reports the outcome as unavailable without claiming failure
    expect(html).toContain("Outcome unavailable");
    expect(html).not.toContain("Compaction incomplete");
    expect(html).not.toContain("never recorded a result");
  });

  test("indexes each card when more than one compaction is attributed", () => {
    /** A short cascade renders one card per event with N-of-M framing. */
    // GIVEN two compactions attributed to the selected call
    hookStub = populated([
      makeEvent({ id: "e1" }),
      makeEvent({ id: "e2", createdAt: Date.parse("2026-05-26T13:00:00Z") }),
    ]);
    // WHEN the tab renders
    const html = render();
    // THEN each card carries its position in the cascade
    expect(html).toContain("1 of 2");
    expect(html).toContain("2 of 2");
  });

  test("omits the index framing for a single compaction", () => {
    /** A lone compaction does not show "1 of 1" noise. */
    // GIVEN a single attributed compaction
    hookStub = populated([makeEvent()]);
    // WHEN the tab renders
    const html = render();
    // THEN no N-of-M framing is shown
    expect(html).not.toContain(" of 1");
  });

  test("offers the summary-text toggle when summaryText is present", () => {
    /** A stored summary exposes the expand control. */
    // GIVEN a compaction with summary text
    hookStub = populated([makeEvent({ summaryText: "Replaced span." })]);
    // WHEN the tab renders
    const html = render();
    // THEN the expand control is offered
    expect(html).toContain("Show summary text");
  });

  test("omits the summary-text toggle when summaryText is null", () => {
    /** Without summary text the expand control is hidden. */
    // GIVEN a compaction with no summary text
    hookStub = populated([makeEvent({ summaryText: null })]);
    // WHEN the tab renders
    const html = render();
    // THEN the expand control is absent
    expect(html).not.toContain("Show summary text");
  });

  test("renders MISSING_VALUE for fields the legacy fallback can't recover", () => {
    /**
     * The legacy `llm_request_logs` projection leaves most fields null;
     * they must render as the shared sentinel, not blanks or zeros.
     */
    // GIVEN a sparse legacy-style event with most fields null
    hookStub = populated([
      makeEvent({
        trigger: null,
        compacted: null,
        summaryFailed: null,
        skipReason: null,
        contextTokensBefore: null,
        contextTokensAfter: null,
        messagesBefore: null,
        messagesAfter: null,
        preservedTailMessages: null,
        durationMs: null,
        compactedMessages: 42,
        summaryModel: "summary-model",
        summaryInputTokens: null,
        summaryOutputTokens: null,
        summaryText: null,
      }),
    ]);
    // WHEN the tab renders
    const html = render();
    // THEN the recoverable fields render and the rest fall back to the sentinel
    expect(html).toContain("42 compacted");
    expect(html).toContain("summary-model");
    expect(html).toContain("Unavailable");
  });
});

describe("CompactionTab — call-scoped wiring", () => {
  test("passes the entry id to the hook as callId", () => {
    /** The selected call's id scopes the query key. */
    // GIVEN a selected call with a known id
    hookStub = populated([]);
    // WHEN the tab renders for that entry
    render(makeEntry({ id: "call-scoped-id-42" }));
    // THEN the hook receives the assistant, conversation, and call ids
    expect(hookCallArgs.length).toBeGreaterThan(0);
    const last = hookCallArgs[hookCallArgs.length - 1]!;
    expect(last.assistantId).toBe("asst-1");
    expect(last.conversationId).toBe("conv-1");
    expect(last.callId).toBe("call-scoped-id-42");
  });
});
