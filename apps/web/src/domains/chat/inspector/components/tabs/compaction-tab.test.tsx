/**
 * Tests for the CompactionTab component.
 *
 * Strategy mirrors `inspect-page.test.tsx`: render to static markup
 * (no DOM), mock the hook at the module boundary so each branch
 * (loading / error / empty / populated) can be exercised in
 * isolation.
 *
 * Interactive behavior (the Show/Hide summary excerpt toggle) is not
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
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    inputTokens: 180_000,
    outputTokens: 4_500,
    durationMs: 8_000,
    responsePreview: "Summary excerpt for the test event.",
    requestMessageCount: 120,
    stopReason: "end_turn",
    estimatedCostUsd: 0.5,
    ...overrides,
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
    const html = render();
    expect(html).toContain("Loading compaction trail");
  });
});

describe("CompactionTab — error state", () => {
  test("surfaces the underlying error message and a retry control", () => {
    hookStub = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("daemon offline"),
      refetch: () => {},
    };
    const html = render();
    expect(html).toContain("Failed to load");
    expect(html).toContain("daemon offline");
    expect(html).toContain("Retry");
  });
});

describe("CompactionTab — empty state", () => {
  test("renders the call-scoped empty-state copy when no events are returned", () => {
    hookStub = {
      data: { conversationId: "conv-1", events: [] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };
    const html = render();
    expect(html).toContain("No compaction ran before this call");
  });
});

describe("CompactionTab — populated state", () => {
  test("renders aggregate totals and one card per event", () => {
    hookStub = {
      data: {
        conversationId: "conv-1",
        events: [
          makeEvent({ id: "e1", inputTokens: 100_000, outputTokens: 5_000 }),
          makeEvent({
            id: "e2",
            inputTokens: 80_000,
            outputTokens: 4_000,
            createdAt: Date.parse("2026-05-26T13:00:00Z"),
          }),
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };

    const html = render();

    // Aggregate row shows the rolled-up input-token sum.
    expect(html).toContain("180,000");
    // Each event renders an "Compaction N / total" header.
    expect(html).toContain("Compaction 1");
    expect(html).toContain("Compaction 2");
    // The chronological "/ 2" framing is part of the header.
    expect(html).toContain("/ 2");
  });

  test("renders a compression ratio next to the token row", () => {
    hookStub = {
      data: {
        conversationId: "conv-1",
        events: [
          makeEvent({
            id: "e-compress",
            inputTokens: 200_000,
            outputTokens: 5_000,
          }),
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };

    const html = render();
    // 200_000 / 5_000 = 40
    expect(html).toContain("40× smaller");
  });

  test("flags non-end_turn stop reasons in the failure count", () => {
    hookStub = {
      data: {
        conversationId: "conv-1",
        events: [
          makeEvent({ id: "e-ok", stopReason: "end_turn" }),
          makeEvent({
            id: "e-err",
            stopReason: "provider_error",
            outputTokens: 0,
            responsePreview: null,
          }),
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };

    const html = render();
    expect(html).toContain("1 failed");
    // The failed event still renders the stop_reason row so engineers
    // can see why it failed.
    expect(html).toContain("provider_error");
  });

  test("omits the summary excerpt control when responsePreview is null", () => {
    hookStub = {
      data: {
        conversationId: "conv-1",
        events: [makeEvent({ responsePreview: null })],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };
    const html = render();
    expect(html).not.toContain("Show summary excerpt");
  });

  test("renders the call-scoped subtitle phrasing", () => {
    hookStub = {
      data: {
        conversationId: "conv-1",
        events: [makeEvent({ id: "e1" }), makeEvent({ id: "e2" })],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };
    const html = render();
    expect(html).toContain("2 compactions before this call");
  });
});

describe("CompactionTab — call-scoped wiring", () => {
  test("passes the entry id to the hook as callId", () => {
    hookStub = {
      data: { conversationId: "conv-1", events: [] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };
    render(makeEntry({ id: "call-scoped-id-42" }));
    expect(hookCallArgs.length).toBeGreaterThan(0);
    const last = hookCallArgs[hookCallArgs.length - 1]!;
    expect(last.assistantId).toBe("asst-1");
    expect(last.conversationId).toBe("conv-1");
    expect(last.callId).toBe("call-scoped-id-42");
  });
});

describe("CompactionTab — null-safe aggregates (Codex P2)", () => {
  test("does not coerce null aggregate inputs to zero in the SummaryCard", () => {
    hookStub = {
      data: {
        conversationId: "conv-1",
        events: [
          // First event has all fields populated.
          makeEvent({
            id: "e-full",
            inputTokens: 100_000,
            outputTokens: 5_000,
            estimatedCostUsd: 0.25,
            durationMs: 8_000,
          }),
          // Second event is partial — null tokens / cost / duration.
          // The aggregate should NOT silently coerce these to zero
          // and report "100,000 tokens" as a "Total". It should
          // surface MISSING_VALUE so engineers see that data is
          // missing rather than an underreported sum.
          makeEvent({
            id: "e-partial",
            inputTokens: null,
            outputTokens: null,
            estimatedCostUsd: null,
            durationMs: null,
          }),
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };

    const html = render();
    // The concrete "100,000" should appear ONCE — in the populated
    // EventCard. If the bug were present the SummaryCard would also
    // render "100,000" as the rolled-up total (occurrences === 2).
    const occurrences = (html.match(/100,000/g) ?? []).length;
    expect(occurrences).toBe(1);
    // And the SummaryCard renders the MISSING_VALUE sentinel for the
    // affected aggregates.
    expect(html).toContain("Unavailable");
  });

  test("renders concrete totals when every event has the field", () => {
    hookStub = {
      data: {
        conversationId: "conv-1",
        events: [
          makeEvent({
            id: "e1",
            inputTokens: 60_000,
            outputTokens: 2_000,
            estimatedCostUsd: 0.10,
            durationMs: 5_000,
          }),
          makeEvent({
            id: "e2",
            inputTokens: 40_000,
            outputTokens: 1_500,
            estimatedCostUsd: 0.08,
            durationMs: 7_000,
          }),
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };

    const html = render();
    // SummaryCard total of input tokens: 60,000 + 40,000 = 100,000.
    expect(html).toContain("100,000");
  });
});
