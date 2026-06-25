/**
 * Tests for `AcpRunDetailPanel` — the ACP run side-drawer.
 *
 * Runs under happy-dom (see clients/web/test-setup.ts). `ToolDetailBody` (reused
 * for the tool nested view) subscribes to the chat-session store, which
 * transitively pulls in the generated daemon SDK; stub every endpoint so the
 * module loads, then import the panel dynamically so the mock registers first.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const sdkStub = async () => ({ data: undefined });
const realSdkPath = new URL(
  "../../../../generated/daemon/sdk.gen.ts",
  import.meta.url,
).pathname;
const sdkSource = await Bun.file(realSdkPath).text();
const exportNames = [...sdkSource.matchAll(/^export const (\w+)/gm)].map(
  (m) => m[1]!,
);
const sdkMock = Object.fromEntries(exportNames.map((n) => [n, sdkStub]));
mock.module("@/generated/daemon/sdk.gen", () => sdkMock);

const { AcpRunDetailPanel } = await import(
  "@/domains/chat/components/acp-run-detail-panel/acp-run-detail-panel"
);
const { useAcpRunStore } = await import("@/domains/chat/acp-run-store");
import type {
  AcpRunEntry,
  AcpRunRawEvent,
} from "@/domains/chat/acp-run-store";

const noop = () => {};

function makeEntry(overrides: Partial<AcpRunEntry> = {}): AcpRunEntry {
  return {
    acpSessionId: "acp-1",
    agent: "claude",
    parentConversationId: "conv-1",
    task: "Research the thing",
    status: "running",
    startedAt: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    events: [],
    ...overrides,
  };
}

/** Seed the store so `useLiveAcpToolOutput` resolves the run's events. */
function seedStore(entry: AcpRunEntry) {
  useAcpRunStore.setState((s) => ({
    byId: { ...s.byId, [entry.acpSessionId]: entry },
    orderedIds: s.orderedIds.includes(entry.acpSessionId)
      ? s.orderedIds
      : [...s.orderedIds, entry.acpSessionId],
  }));
}

const TOOL_CALL_EVENT: AcpRunRawEvent = {
  seq: 1,
  updateType: "tool_call",
  toolCallId: "tool-1",
  toolTitle: "Read file",
  toolKind: "read",
  toolStatus: "running",
};

afterEach(() => {
  cleanup();
  useAcpRunStore.getState().reset();
});
afterAll(() => {
  mock.restore();
});

describe("AcpRunDetailPanel — header + metrics + objective", () => {
  test("renders agent title, status, metrics, and objective", () => {
    render(
      <AcpRunDetailPanel
        entry={makeEntry({ inputTokens: 1200, outputTokens: 340 })}
        onClose={noop}
      />,
    );

    expect(screen.getByText("claude")).toBeDefined();
    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByText("Input")).toBeDefined();
    expect(screen.getByText("Output")).toBeDefined();
    expect(screen.getByText("1.2K")).toBeDefined();
    expect(screen.getByText("340")).toBeDefined();
    expect(screen.getByText("Objective")).toBeDefined();
    expect(screen.getByText("Research the thing")).toBeDefined();
  });

  test("empty events renders 'No events yet'", () => {
    render(<AcpRunDetailPanel entry={makeEntry({ events: [] })} onClose={noop} />);
    expect(screen.getByText("No events yet")).toBeDefined();
  });

  test("Stop button renders only while running and calls onStop", () => {
    const stopped: string[] = [];
    render(
      <AcpRunDetailPanel
        entry={makeEntry({ status: "running" })}
        onClose={noop}
        onStop={(id) => stopped.push(id)}
      />,
    );
    fireEvent.click(screen.getByLabelText("Stop run"));
    expect(stopped).toEqual(["acp-1"]);
  });

  test("Stop button is hidden for a terminal run", () => {
    render(
      <AcpRunDetailPanel
        entry={makeEntry({ status: "completed" })}
        onClose={noop}
        onStop={noop}
      />,
    );
    expect(screen.queryByLabelText("Stop run")).toBeNull();
  });

  test("close button fires onClose", () => {
    let closed = 0;
    render(
      <AcpRunDetailPanel
        entry={makeEntry()}
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close run detail"));
    expect(closed).toBe(1);
  });
});

describe("AcpRunDetailPanel — timeline + nested detail", () => {
  test("clicking a tool pill swaps to the tool detail with joined output, Back returns", () => {
    const entry = makeEntry({
      events: [
        { ...TOOL_CALL_EVENT, toolStatus: "completed" },
        {
          seq: 2,
          updateType: "tool_call_update",
          toolCallId: "tool-1",
          toolStatus: "completed",
          content: "file-listing-output",
        },
      ],
    });
    seedStore(entry);
    render(<AcpRunDetailPanel entry={entry} onClose={noop} />);

    // Timeline view first.
    expect(screen.getByText("Read file")).toBeDefined();
    expect(screen.queryByLabelText("Back to timeline")).toBeNull();

    fireEvent.click(screen.getByTestId("acp-step-pill"));

    // Nested tool detail: Output section with the joined output, breadcrumb,
    // and a Back button; no "Technical details" label (nested under header).
    expect(screen.getByText("Output")).toBeDefined();
    expect(screen.getByText("file-listing-output")).toBeDefined();
    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.getByLabelText("Back to timeline")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Back to timeline"));
    expect(screen.getByText("Timeline")).toBeDefined();
    expect(screen.queryByLabelText("Back to timeline")).toBeNull();
  });

  test("a still-running tool shows 'Running…' and streams live as updates arrive", () => {
    const entry = makeEntry({ events: [TOOL_CALL_EVENT] });
    seedStore(entry);
    const { rerender } = render(
      <AcpRunDetailPanel entry={entry} onClose={noop} />,
    );

    fireEvent.click(screen.getByTestId("acp-step-pill"));
    expect(screen.getByText("Running…")).toBeDefined();

    // A `tool_call_update` lands: mutate the store + re-render with the grown
    // entry. The live hook re-derives the joined output from the store.
    const updated = makeEntry({
      events: [
        TOOL_CALL_EVENT,
        {
          seq: 2,
          updateType: "tool_call_update",
          toolCallId: "tool-1",
          toolStatus: "running",
          content: "partial output so far",
        },
      ],
    });
    act(() => {
      seedStore(updated);
    });
    rerender(<AcpRunDetailPanel entry={updated} onClose={noop} />);

    expect(screen.getByText("partial output so far")).toBeDefined();
  });

  test("a message pill renders accumulated markdown", () => {
    const entry = makeEntry({
      events: [
        {
          seq: 1,
          updateType: "agent_message_chunk",
          messageId: "m-1",
          content: "Hello from the agent",
        },
      ],
    });
    seedStore(entry);
    render(<AcpRunDetailPanel entry={entry} onClose={noop} />);

    fireEvent.click(screen.getByTestId("acp-step-pill"));
    expect(screen.getByText("Hello from the agent")).toBeDefined();
    // No tool sections for a message body.
    expect(screen.queryByText("Output")).toBeNull();
  });

  test("a plan pill renders a checklist", () => {
    const entry = makeEntry({
      events: [
        {
          seq: 1,
          updateType: "plan",
          content: JSON.stringify([
            { label: "First step", checked: true },
            { label: "Second step", checked: false },
          ]),
        },
      ],
    });
    seedStore(entry);
    render(<AcpRunDetailPanel entry={entry} onClose={noop} />);

    fireEvent.click(screen.getByTestId("acp-step-pill"));
    expect(screen.getByText("First step")).toBeDefined();
    expect(screen.getByText("Second step")).toBeDefined();
  });

  test("anonymous message steps don't collide — first pill opens the first message", () => {
    // Two `agent_message_chunk`s with no `messageId`, separated by a tool_call so
    // the projector closes the first message and starts a second. Both anonymous
    // steps share `detailKey` "msg:", so selection must key by index, not key.
    const entry = makeEntry({
      events: [
        {
          seq: 1,
          updateType: "agent_message_chunk",
          content: "First anonymous message",
        },
        { ...TOOL_CALL_EVENT, seq: 2, toolStatus: "completed" },
        {
          seq: 3,
          updateType: "agent_message_chunk",
          content: "Second anonymous message",
        },
      ],
    });
    seedStore(entry);
    render(<AcpRunDetailPanel entry={entry} onClose={noop} />);

    const pills = screen.getAllByTestId("acp-step-pill");
    // [message, tool, message]
    expect(pills.length).toBe(3);

    fireEvent.click(pills[0]!);
    expect(screen.getByText("First anonymous message")).toBeDefined();
    expect(screen.queryByText("Second anonymous message")).toBeNull();
  });

  test("terminal run's trailing message renders complete, not running", () => {
    // A completed run whose last event is a message chunk: nothing closes it, so
    // the step stays `isComplete:false`. The pill must show complete, not running.
    const events: AcpRunRawEvent[] = [
      {
        seq: 1,
        updateType: "agent_message_chunk",
        messageId: "m-1",
        content: "Final answer",
      },
    ];
    const terminal = makeEntry({ status: "completed", events });
    seedStore(terminal);
    const { rerender } = render(
      <AcpRunDetailPanel entry={terminal} onClose={noop} />,
    );

    expect(screen.queryByTestId("acp-step-running")).toBeNull();
    expect(screen.getByTestId("acp-step-complete")).toBeDefined();

    // The same trailing message on a still-active run DOES show the indicator.
    const active = makeEntry({ status: "running", events });
    seedStore(active);
    rerender(<AcpRunDetailPanel entry={active} onClose={noop} />);

    expect(screen.getByTestId("acp-step-running")).toBeDefined();
  });

  test("nested state resets when switching to a different run", () => {
    const entry = makeEntry({ events: [TOOL_CALL_EVENT] });
    seedStore(entry);
    const { rerender } = render(
      <AcpRunDetailPanel entry={entry} onClose={noop} />,
    );

    fireEvent.click(screen.getByTestId("acp-step-pill"));
    expect(screen.getByLabelText("Back to timeline")).toBeDefined();

    const other = makeEntry({
      acpSessionId: "acp-2",
      agent: "gemini",
      events: [],
    });
    seedStore(other);
    rerender(<AcpRunDetailPanel entry={other} onClose={noop} />);

    // Reset to the timeline for the new run — no leaked nested detail.
    expect(screen.queryByLabelText("Back to timeline")).toBeNull();
    expect(screen.getByText("Timeline")).toBeDefined();
    expect(screen.getByText("gemini")).toBeDefined();
  });
});
