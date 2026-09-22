/**
 * The detail panel's Input/Output cards always render their real formatted
 * values. The metrics stream in as the subagent makes LLM calls, so the
 * cards start at `0` and tick up; there are no skeleton loading states,
 * even while the subagent is still running with zeroed usage.
 *
 * Heavy children (avatar, status badge, timeline) are stubbed so we can assert
 * the metric-row behavior without depending on their internals.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

mock.module("@/components/avatar-renderer", () => ({
  AvatarRenderer: () => <div data-testid="avatar" />,
}));

// Detail addressability is version-gated; pin it on so the open-fetch tests
// below exercise the parent-only fallback a 0.11.0+ daemon supports.
mock.module("@/lib/backwards-compat/subagent-detail-self-lookup", () => ({
  supportsSubagentDetailSelfLookup: () => true,
}));

mock.module("@/domains/chat/components/subagent-status-badge", () => ({
  StatusBadge: ({ status }: { status: string }) => (
    <div data-testid="status-badge" data-status={status} />
  ),
}));

// The real timeline is exercised in its own test; here we stub it so the panel
// tests stay focused on the panel's own behavior. The stub renders a button
// that forwards a fixed tool-call id to the panel's `onStepDetailClick`, letting
// us drive the nested tool-detail swap without depending on the timeline's
// expand/pill internals.
mock.module("@/domains/chat/components/subagent-phase-timeline", () => ({
  SubagentPhaseTimeline: ({
    onStepDetailClick,
    expandedKeys,
    onExpandedKeysChange,
  }: {
    onStepDetailClick?: (detailKey: string) => void;
    expandedKeys?: Set<string>;
    onExpandedKeysChange?: (
      updater: (prev: Set<string>) => Set<string>,
    ) => void;
  }) => (
    <div data-testid="timeline">
      {/* Surfaces the controlled expand state so a test can assert the panel
          preserves it across the detail view swap. The real timeline drives the
          functional-updater form, so the stub exercises the same contract. */}
      <button
        type="button"
        data-testid="timeline-expand"
        onClick={() =>
          onExpandedKeysChange?.((prev) => new Set(prev).add("grp-1"))
        }
      >
        {expandedKeys?.has("grp-1") ? "group-open" : "group-closed"}
      </button>
      <button
        type="button"
        data-testid="timeline-pill"
        onClick={() => onStepDetailClick?.("tool-1")}
      >
        pill
      </button>
      <button
        type="button"
        data-testid="timeline-thinking-pill"
        onClick={() => onStepDetailClick?.("think-1")}
      >
        thinking
      </button>
      <button
        type="button"
        data-testid="timeline-fetch-pill"
        onClick={() => onStepDetailClick?.("fetch-1")}
      >
        fetch
      </button>
    </div>
  ),
}));

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { SubagentDetailPanel } from "@/domains/chat/components/subagent-detail-panel";
import {
  useSubagentStore,
  type SubagentEntry,
} from "@/domains/chat/subagent-store";
import { emptyHistory } from "@/domains/chat/transcript/rolling-snapshot";
import { stubOverflow } from "@/hooks/overflow.test-helper";

// The live tool-call hook also reads the transcript union, which is backed by a
// TanStack Query cache. Render every case under a provider so drilling into a
// tool step doesn't throw "No QueryClient set".
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const render = (ui: Parameters<typeof rtlRender>[0]) =>
  rtlRender(ui, { wrapper });

const noop = () => {};

function makeEntry(overrides: Partial<SubagentEntry> = {}): SubagentEntry {
  return {
    subagentId: "sub-1",
    label: "Research agent",
    objective: "Do the thing",
    status: "running",
    isFork: false,
    inputTokens: 0,
    outputTokens: 0,
    spawnedAt: Date.now(),
    events: [],
    history: null,
    ...overrides,
  };
}

/**
 * `entry` with a history holding `toolCalls`, registered in the subagent store,
 * which is where the nested tool detail reads a subagent's calls from.
 */
function withToolCalls(
  entry: SubagentEntry,
  toolCalls: ChatMessageToolCall[],
): SubagentEntry {
  const seeded: SubagentEntry = {
    ...entry,
    history: {
      ...emptyHistory(),
      messages: [
        { id: `msg-${entry.subagentId}`, role: "assistant", toolCalls },
      ],
    },
  };
  useSubagentStore.setState((s) => ({
    byId: { ...s.byId, [seeded.subagentId]: seeded },
  }));
  return seeded;
}

/** Skeleton bars (if any) pulse; real values are plain text. */
function skeletonCount(container: HTMLElement): number {
  return container.querySelectorAll(".animate-pulse").length;
}

afterEach(() => {
  cleanup();
  useSubagentStore.getState().reset();
});
afterAll(() => {
  mock.restore();
});

describe("SubagentDetailPanel — metric cards", () => {
  test("running with zero usage renders real zeros, not skeletons", () => {
    const { container } = render(
      <SubagentDetailPanel
        entry={makeEntry({
          status: "running",
          inputTokens: 0,
          outputTokens: 0,
        })}
        onClose={noop}
      />,
    );

    expect(skeletonCount(container)).toBe(0);
    expect(screen.getByText("Input")).toBeDefined();
    expect(screen.getByText("Output")).toBeDefined();
    // Only Input + Output render, each a live "0"; cost is never shown.
    expect(screen.queryByText("Cost")).toBeNull();
    expect(screen.getAllByText("0").length).toBe(2);
  });

  test("running with usage renders real values", () => {
    const { container } = render(
      <SubagentDetailPanel
        entry={makeEntry({
          status: "running",
          inputTokens: 1200,
          outputTokens: 340,
        })}
        onClose={noop}
      />,
    );

    expect(skeletonCount(container)).toBe(0);
    expect(screen.getByText("1.2K")).toBeDefined();
    expect(screen.getByText("340")).toBeDefined();
  });

  test("terminal subagent renders real values including a legitimate zero", () => {
    const { container } = render(
      <SubagentDetailPanel
        entry={makeEntry({
          status: "completed",
          inputTokens: 0,
          outputTokens: 0,
        })}
        onClose={noop}
      />,
    );

    expect(skeletonCount(container)).toBe(0);
    // Both zero input/output values render as real text, never skeletons.
    expect(screen.getAllByText("0").length).toBe(2);
  });
});

describe("SubagentDetailPanel — timeline empty state", () => {
  test("empty events renders 'No events yet'", () => {
    render(
      <SubagentDetailPanel entry={makeEntry({ events: [] })} onClose={noop} />,
    );
    expect(screen.getByText("No events yet")).toBeDefined();
    expect(screen.queryByTestId("timeline")).toBeNull();
  });

  test("non-empty events that project to zero steps do NOT render 'No events yet'", () => {
    // A lone `tool_result` with no preceding in-flight `tool_call` is
    // intentionally dropped by `computeSubagentCardData`, so `steps` is
    // empty while `entry.events` is non-empty. The empty state must gate on
    // raw events, so "No events yet" must NOT appear (and the timeline
    // renders — a no-op for zero steps).
    render(
      <SubagentDetailPanel
        entry={makeEntry({
          events: [
            {
              id: "te-orphan",
              type: "tool_result",
              content: "ok",
              toolName: "bash",
              timestamp: Date.now(),
            },
          ],
        })}
        onClose={noop}
      />,
    );
    expect(screen.queryByText("No events yet")).toBeNull();
    expect(screen.getByTestId("timeline")).toBeDefined();
  });
});

/**
 * Opening the panel is what pays for a settled subagent's timeline: the
 * conversation-load auto-fetch only covers live rows, so this is the single
 * fetch trigger for everything reconcile materializes as terminal.
 */
describe("SubagentDetailPanel: detail fetch on open", () => {
  function requestedIdsFor(entry: Partial<SubagentEntry>): string[] {
    const requested: string[] = [];
    render(
      <SubagentDetailPanel
        entry={makeEntry(entry)}
        onClose={noop}
        onRequestDetail={(id) => requested.push(id)}
      />,
    );
    return requested;
  }

  test("fetches a settled row with an empty timeline", () => {
    expect(
      requestedIdsFor({ status: "completed", conversationId: "conv-child" }),
    ).toEqual(["sub-1"]);
  });

  test("fetches a stub that knows only its parent conversation", () => {
    // The child-semantic `conversationId` is deliberately unset on such a
    // stub; gating the fetch on it left the panel permanently empty.
    expect(
      requestedIdsFor({
        conversationId: undefined,
        parentConversationId: "conv-parent",
      }),
    ).toEqual(["sub-1"]);
  });

  test("does not fetch for an entry no id can address", () => {
    expect(requestedIdsFor({ conversationId: undefined })).toEqual([]);
  });

  test("does not fetch for an entry that already has a timeline", () => {
    expect(
      requestedIdsFor({
        conversationId: "conv-child",
        events: [
          {
            id: "te-1",
            type: "text",
            content: "hello",
            timestamp: Date.now(),
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("SubagentDetailPanel — header controls", () => {
  test("Stop button renders only while running and calls onStop", () => {
    const stopped: string[] = [];
    render(
      <SubagentDetailPanel
        entry={makeEntry({ status: "running" })}
        onClose={noop}
        onStop={(id) => stopped.push(id)}
      />,
    );

    const stopButton = screen.getByLabelText("Stop subagent");
    fireEvent.click(stopButton);
    expect(stopped).toEqual(["sub-1"]);
  });

  test("Stop button is hidden for a terminal subagent", () => {
    render(
      <SubagentDetailPanel
        entry={makeEntry({ status: "completed" })}
        onClose={noop}
        onStop={noop}
      />,
    );
    expect(screen.queryByLabelText("Stop subagent")).toBeNull();
  });

  test("close button fires onClose", () => {
    let closed = 0;
    render(
      <SubagentDetailPanel
        entry={makeEntry()}
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close subagent detail"));
    expect(closed).toBe(1);
  });
});

describe("SubagentDetailPanel — objective", () => {
  const longObjective = "x ".repeat(400).trim();

  test("is a section heading, like the timeline below it", () => {
    render(<SubagentDetailPanel entry={makeEntry()} onClose={noop} />);
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toContain("Objective");
    expect(headings).toContain("Timeline");
  });

  test("a long objective folds behind the shared Show more, which opens and closes it", () => {
    const restore = stubOverflow((el) => el.textContent === longObjective);
    try {
      render(
        <SubagentDetailPanel
          entry={makeEntry({ objective: longObjective })}
          onClose={noop}
        />,
      );

      fireEvent.click(screen.getByText("Show more"));
      expect(screen.getByText("Show less")).toBeDefined();
      fireEvent.click(screen.getByText("Show less"));
      expect(screen.getByText("Show more")).toBeDefined();
    } finally {
      restore();
    }
  });

  test("a short objective renders no toggle", () => {
    const restore = stubOverflow(() => false);
    try {
      render(
        <SubagentDetailPanel
          entry={makeEntry({ objective: "Short" })}
          onClose={noop}
        />,
      );
      expect(screen.getByText("Short")).toBeDefined();
      expect(screen.queryByText("Show more")).toBeNull();
      expect(screen.queryByText("Show less")).toBeNull();
    } finally {
      restore();
    }
  });

  test("an objective opened for one subagent is folded again for the next", () => {
    // The desktop parent reuses this component instance across subagent
    // switches (no React `key`), so the objective's own open state has to
    // reset when the subagent changes, including when the next subagent's
    // objective is byte-identical.
    const restore = stubOverflow((el) => el.textContent === longObjective);
    try {
      const { rerender } = render(
        <SubagentDetailPanel
          entry={makeEntry({ subagentId: "sub-1", objective: longObjective })}
          onClose={noop}
        />,
      );
      fireEvent.click(screen.getByText("Show more"));
      expect(screen.getByText("Show less")).toBeDefined();

      rerender(
        <SubagentDetailPanel
          entry={makeEntry({ subagentId: "sub-2", objective: longObjective })}
          onClose={noop}
        />,
      );
      expect(screen.getByText("Show more")).toBeDefined();
      expect(screen.queryByText("Show less")).toBeNull();

      rerender(
        <SubagentDetailPanel
          entry={makeEntry({ subagentId: "sub-3", objective: "Short" })}
          onClose={noop}
        />,
      );
      expect(screen.queryByText("Show more")).toBeNull();
      expect(screen.queryByText("Show less")).toBeNull();
    } finally {
      restore();
    }
  });
});

/**
 * A bash call whose id matches the id the stubbed timeline forwards (`tool-1`),
 * in both the timeline events and the history the nested detail reads.
 * `completed` overrides whether the call has a result (closed) or is still in
 * flight (running output state).
 */
function entryWithTool(completed: boolean): SubagentEntry {
  const now = Date.now();
  const toolCall: ChatMessageToolCall = {
    id: "tool-1",
    name: "bash",
    input: { command: "ls -la" },
    startedAt: now,
    ...(completed
      ? { result: "file-listing-output", completedAt: now + 1000 }
      : {}),
  };
  return withToolCalls(
    makeEntry({
      events: [
        {
          id: "te-call",
          type: "tool_call",
          content: "ls -la",
          toolName: "bash",
          toolUseId: "tool-1",
          input: { command: "ls -la" },
          timestamp: now,
        },
        ...(completed
          ? [
              {
                id: "te-result",
                type: "tool_result" as const,
                content: "file-listing-output",
                result: "file-listing-output",
                toolName: "bash",
                toolUseId: "tool-1",
                timestamp: now + 1000,
              },
            ]
          : []),
      ],
    }),
    [toolCall],
  );
}

/**
 * A single `text` event whose id matches the key the stubbed thinking pill
 * forwards (`think-1`), so `buildSubagentStepDetails(entry)` produces a
 * `kind: "thinking"` payload carrying the full reasoning markdown.
 */
function entryWithThinking(): SubagentEntry {
  return makeEntry({
    events: [
      {
        id: "think-1",
        type: "text",
        content: "Full reasoning the pill preview truncates.",
        timestamp: Date.now(),
      },
    ],
  });
}

const WEB_FETCH_RESULT = `Final URL: https://www.example.com/article
Status: 200 OK

Content:
<external_content source="web" origin="https://www.example.com/article">
The extracted article body.
</external_content>`;

/** A single timeline event, so the panel renders its (stubbed) timeline. */
const TOOL_EVENT: SubagentEntry["events"][number] = {
  id: "te-call",
  type: "tool_call",
  content: "",
  timestamp: 0,
};

/**
 * A settled `web_fetch` call keyed `fetch-1` (the id the stubbed timeline's
 * fetch pill forwards), which the panel routes to `WebFetchDetailView`.
 */
function entryWithWebFetch(): SubagentEntry {
  const now = Date.now();
  return withToolCalls(makeEntry({ events: [TOOL_EVENT] }), [
    {
      id: "fetch-1",
      name: "web_fetch",
      input: { url: "https://www.example.com/article" },
      startedAt: now,
      result: WEB_FETCH_RESULT,
      completedAt: now + 1000,
    },
  ]);
}

describe("SubagentDetailPanel: nested detail reads the live call", () => {
  test("the drawer shows the call's risk level and streamed output, then its result", () => {
    const entry = withToolCalls(makeEntry({ events: [TOOL_EVENT] }), [
      {
        id: "tool-1",
        name: "bash",
        input: { command: "npm test" },
        startedAt: Date.now(),
        riskLevel: "high",
        streamedOutput: "partial-output",
      },
    ]);
    render(<SubagentDetailPanel entry={entry} onClose={noop} />);
    fireEvent.click(screen.getByTestId("timeline-pill"));

    expect(
      screen.getByTestId("risk-badge").getAttribute("data-risk-level"),
    ).toBe("high");
    expect(screen.getByText("partial-output")).toBeDefined();

    // The result lands on the subagent's history while the drawer is open.
    act(() => {
      withToolCalls(entry, [
        {
          id: "tool-1",
          name: "bash",
          input: { command: "npm test" },
          startedAt: 1,
          completedAt: 2,
          riskLevel: "high",
          result: "all-tests-passed",
        },
      ]);
    });
    expect(screen.getByText("all-tests-passed")).toBeDefined();
    expect(screen.queryByTestId("nested-detail-running")).toBeNull();
  });

  test("a web search shows the query and sources from its activity metadata", () => {
    const entry = withToolCalls(makeEntry({ events: [TOOL_EVENT] }), [
      {
        id: "tool-1",
        name: "web_search",
        input: { query: "vellum" },
        startedAt: 1,
        completedAt: 2,
        result: "unparsed provider text",
        activityMetadata: {
          webSearch: {
            query: "vellum assistant",
            provider: "brave",
            resultCount: 1,
            durationMs: 1,
            results: [
              {
                rank: 1,
                title: "Vellum",
                url: "https://vellum.ai",
                domain: "vellum.ai",
              },
            ],
          },
        },
      },
    ]);
    render(<SubagentDetailPanel entry={entry} onClose={noop} />);
    fireEvent.click(screen.getByTestId("timeline-pill"));

    expect(screen.getByText("vellum assistant")).toBeDefined();
    expect(screen.getByText("Sources (1)")).toBeDefined();
    expect(screen.queryByText("unparsed provider text")).toBeNull();
  });

  test("a pill whose call is only in the timeline events opens the event-built detail", () => {
    const events: SubagentEntry["events"] = [
      {
        id: "te-call",
        type: "tool_call",
        content: "ls",
        toolName: "bash",
        toolUseId: "tool-1",
        input: { command: "ls" },
        timestamp: 0,
      },
      {
        id: "te-result",
        type: "tool_result",
        content: "event-output",
        result: "event-output",
        toolName: "bash",
        toolUseId: "tool-1",
        timestamp: 10,
      },
    ];
    // History is present but keyed by an id the events never carried (a
    // positional id from an older assistant), so the canonical lookup misses.
    const entry = withToolCalls(makeEntry({ events }), [
      {
        id: "tool-history-msg-1-0",
        name: "bash",
        input: { command: "ls" },
        result: "canonical-output",
      },
    ]);
    render(<SubagentDetailPanel entry={entry} onClose={noop} />);
    fireEvent.click(screen.getByTestId("timeline-pill"));

    expect(screen.queryByTestId("timeline")).toBeNull();
    expect(screen.getByText("event-output")).toBeDefined();
  });

  test("a finished event-built detail wins over a canonical copy still running", () => {
    const events: SubagentEntry["events"] = [
      {
        id: "te-call",
        type: "tool_call",
        content: "ls",
        toolName: "bash",
        toolUseId: "tool-1",
        input: { command: "ls" },
        timestamp: 0,
      },
      {
        id: "te-result",
        type: "tool_result",
        content: "event-output",
        result: "event-output",
        toolName: "bash",
        toolUseId: "tool-1",
        timestamp: 10,
      },
    ];
    // Seeded from a snapshot older than the result the timeline already has.
    const entry = withToolCalls(makeEntry({ events }), [
      { id: "tool-1", name: "bash", input: { command: "ls" } },
    ]);
    render(<SubagentDetailPanel entry={entry} onClose={noop} />);
    fireEvent.click(screen.getByTestId("timeline-pill"));

    expect(screen.getByText("event-output")).toBeDefined();
  });

  test("a pill with nothing behind it in either source stays on the timeline", () => {
    render(
      <SubagentDetailPanel
        entry={makeEntry({ events: [TOOL_EVENT] })}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByTestId("timeline-pill"));
    expect(screen.getByTestId("timeline")).toBeDefined();
  });
});

describe("SubagentDetailPanel — nested tool detail", () => {
  test("the top-level timeline view shows no breadcrumb", () => {
    render(<SubagentDetailPanel entry={entryWithTool(true)} onClose={noop} />);

    // Top-level: no Back button and no breadcrumb. The subagent's clickable
    // breadcrumb crumb is a button, so its absence here proves the breadcrumb
    // bar is not rendered on the timeline view.
    expect(screen.queryByLabelText("Back to timeline")).toBeNull();
    expect(screen.queryByRole("button", { name: "Research agent" })).toBeNull();

    // Drilling into a step reveals the breadcrumb's clickable subagent crumb.
    fireEvent.click(screen.getByTestId("timeline-pill"));
    expect(
      screen.getByRole("button", { name: "Research agent" }),
    ).toBeDefined();
  });

  test("clicking a timeline tool pill swaps the body to the tool detail while keeping the header", () => {
    render(<SubagentDetailPanel entry={entryWithTool(true)} onClose={noop} />);

    // Timeline view first — the subagent avatar leads the header.
    expect(screen.getByTestId("timeline")).toBeDefined();
    expect(screen.queryByLabelText("Back to timeline")).toBeNull();
    expect(screen.getByTestId("avatar")).toBeDefined();

    fireEvent.click(screen.getByTestId("timeline-pill"));

    // Detail body is shown (tool input + Output sections). The nested view
    // omits the "Technical details" label — redundant under the subagent
    // header + "Back" affordance — so it must NOT appear.
    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.getByText("Output")).toBeDefined();
    expect(screen.getByText("file-listing-output")).toBeDefined();
    // Timeline is no longer rendered (body swapped, not stacked).
    expect(screen.queryByTestId("timeline")).toBeNull();
    // The subagent stays present as the breadcrumb's parent crumb, and the
    // header gains a Back button while the close (X) stays mounted.
    expect(screen.getByText("Research agent")).toBeDefined();
    expect(screen.getByLabelText("Back to timeline")).toBeDefined();
    expect(screen.getByLabelText("Close subagent detail")).toBeDefined();
    // The avatar is replaced by the step's own icon; a settled (completed) tool
    // shows the icon, not the running indicator.
    expect(screen.queryByTestId("avatar")).toBeNull();
    expect(screen.queryByTestId("nested-detail-running")).toBeNull();
  });

  test("an opened objective is still open after a step's detail and Back", () => {
    const longObjective = "x ".repeat(400).trim();
    const restore = stubOverflow((el) => el.textContent === longObjective);
    try {
      render(
        <SubagentDetailPanel
          entry={{ ...entryWithTool(true), objective: longObjective }}
          onClose={noop}
        />,
      );
      fireEvent.click(screen.getByText("Show more"));

      fireEvent.click(screen.getByTestId("timeline-pill"));
      fireEvent.click(screen.getByLabelText("Back to timeline"));

      expect(screen.getByText("Show less")).toBeDefined();
    } finally {
      restore();
    }
  });

  test("'Back' restores the timeline view", () => {
    render(<SubagentDetailPanel entry={entryWithTool(true)} onClose={noop} />);

    fireEvent.click(screen.getByTestId("timeline-pill"));
    expect(screen.getByText("Output")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Back to timeline"));
    expect(screen.getByTestId("timeline")).toBeDefined();
    expect(screen.queryByLabelText("Back to timeline")).toBeNull();
  });

  test("selecting a still-running tool shows the 'Running…' output state", () => {
    render(<SubagentDetailPanel entry={entryWithTool(false)} onClose={noop} />);

    fireEvent.click(screen.getByTestId("timeline-pill"));
    expect(screen.getByText("Output")).toBeDefined();
    expect(screen.getByText("Running…")).toBeDefined();
    // A still-running step leads the header with the running indicator in place
    // of both the avatar and the static step icon.
    expect(screen.getByTestId("nested-detail-running")).toBeDefined();
    expect(screen.queryByTestId("avatar")).toBeNull();
  });

  test("returning via 'Back' preserves the expanded timeline group", () => {
    render(<SubagentDetailPanel entry={entryWithTool(true)} onClose={noop} />);

    // Expand a group.
    expect(screen.getByTestId("timeline-expand").textContent).toBe(
      "group-closed",
    );
    fireEvent.click(screen.getByTestId("timeline-expand"));
    expect(screen.getByTestId("timeline-expand").textContent).toBe(
      "group-open",
    );

    // Open a tool's detail (the timeline unmounts) then return via "Back".
    fireEvent.click(screen.getByTestId("timeline-pill"));
    expect(screen.getByText("Output")).toBeDefined();
    fireEvent.click(screen.getByLabelText("Back to timeline"));

    // The group the user had open is still expanded — the lifted expand state
    // survived the timeline unmounting.
    expect(screen.getByTestId("timeline-expand").textContent).toBe(
      "group-open",
    );
  });

  test("switching to a different subagent resets the nested view and expanded groups", () => {
    // The desktop parent reuses this instance across subagent switches (no
    // React `key`), so neither an open nested detail nor an expanded group may
    // leak onto the next subagent.
    const { rerender } = render(
      <SubagentDetailPanel entry={entryWithTool(true)} onClose={noop} />,
    );

    fireEvent.click(screen.getByTestId("timeline-expand"));
    fireEvent.click(screen.getByTestId("timeline-pill"));
    expect(screen.getByText("Output")).toBeDefined();

    rerender(
      <SubagentDetailPanel
        entry={makeEntry({ subagentId: "sub-2", events: [TOOL_EVENT] })}
        onClose={noop}
      />,
    );

    // Reset to the timeline for the new subagent, with no leaked detail or
    // expansion.
    expect(screen.getByTestId("timeline")).toBeDefined();
    expect(screen.queryByLabelText("Back to timeline")).toBeNull();
    expect(screen.getByTestId("timeline-expand").textContent).toBe(
      "group-closed",
    );
  });

  test("clicking a thinking pill shows its full reasoning, no tool sections", () => {
    render(<SubagentDetailPanel entry={entryWithThinking()} onClose={noop} />);

    fireEvent.click(screen.getByTestId("timeline-thinking-pill"));

    // The full (un-truncated) reasoning is rendered as markdown, with none of
    // the tool-detail sections.
    expect(
      screen.getByText("Full reasoning the pill preview truncates."),
    ).toBeDefined();
    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.queryByText("Output")).toBeNull();
    // Headed "Thinking" (header and breadcrumb), as every panel heads a
    // thinking step, not with the "Thought" its payload was built with.
    expect(screen.getAllByText("Thinking")).toHaveLength(2);
    expect(screen.queryByText("Thought")).toBeNull();

    // Back returns to the timeline.
    fireEvent.click(screen.getByLabelText("Back to timeline"));
    expect(screen.getByTestId("timeline")).toBeDefined();
    expect(screen.queryByLabelText("Back to timeline")).toBeNull();
  });

  test("clicking the subagent breadcrumb returns to the timeline, preserving expanded groups", () => {
    render(<SubagentDetailPanel entry={entryWithTool(true)} onClose={noop} />);

    // Expand a group, then drill into a tool detail.
    fireEvent.click(screen.getByTestId("timeline-expand"));
    expect(screen.getByTestId("timeline-expand").textContent).toBe(
      "group-open",
    );
    fireEvent.click(screen.getByTestId("timeline-pill"));
    expect(screen.queryByTestId("timeline")).toBeNull();

    // In the nested view the subagent is the breadcrumb's parent crumb;
    // clicking it navigates back to the timeline (same as the header Back
    // button), and the previously expanded group survives the round trip.
    fireEvent.click(screen.getByText("Research agent"));
    expect(screen.getByTestId("timeline")).toBeDefined();
    expect(screen.getByTestId("timeline-expand").textContent).toBe(
      "group-open",
    );
  });

  test("a web_fetch pill routes to the source-card view, not the generic body", () => {
    render(<SubagentDetailPanel entry={entryWithWebFetch()} onClose={noop} />);

    fireEvent.click(screen.getByTestId("timeline-fetch-pill"));

    // The web_fetch view shows the source host; the generic technical-details
    // body must NOT appear.
    expect(screen.getByText("example.com")).toBeDefined();
    expect(screen.getByText("200 OK")).toBeDefined();
    expect(screen.queryByText("Technical details")).toBeNull();
  });
});
