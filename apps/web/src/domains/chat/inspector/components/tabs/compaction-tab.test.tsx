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

import type { CompactionTrailEvent } from "../../compaction-trail-types.js";

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

mock.module("@/domains/chat/inspector/compaction-trail-api.js", () => ({
  useCompactionTrail: () => hookStub,
}));

// Imported AFTER the mock so the component picks up the stub.
import { CompactionTab } from "./compaction-tab.js";

function render(): string {
  return renderToStaticMarkup(
    <CompactionTab assistantId="asst-1" conversationId="conv-1" />,
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
  test("renders the empty-state copy when no events are returned", () => {
    hookStub = {
      data: { conversationId: "conv-1", events: [] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };
    const html = render();
    expect(html).toContain("No compaction events recorded");
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
});
