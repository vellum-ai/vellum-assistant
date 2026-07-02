import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

import type { AcpRunEntry, AcpRunRawEvent } from "@/domains/chat/acp-run-store";

const steerAcpRun = mock(async () => ({
  acpSessionId: "acp-1",
  steered: true,
}));
const stopAcpRun = mock(async () => {});

// The real actions module imports the daemon client + resolved-assistants
// store; mock at that boundary so the view's steer/stop calls stay in-process.
mock.module("@/domains/chat/utils/acp-run-actions", () => ({
  steerAcpRun,
  stopAcpRun,
}));

// Modules are imported AFTER the mock registers so the real actions module
// (which pulls in the not-generated daemon client) is never evaluated.
const { useAcpRunStore } = await import("@/domains/chat/acp-run-store");
const { AcpRunChatView } = await import("./acp-run-chat-view");

// Reset only the data slices (merge, not replace) so the store's action
// methods — `appendLocalMarker`, etc. — survive between tests.
function freshState() {
  return {
    byId: {},
    orderedIds: [],
    byToolUseId: new Map<string, string>(),
    highWaterMark: new Map<string, number>(),
  };
}

function entry(overrides: Partial<AcpRunEntry> = {}): AcpRunEntry {
  return {
    acpSessionId: "acp-1",
    agent: "claude",
    parentConversationId: "conv-1",
    task: "Refactor the parser",
    status: "running",
    startedAt: 0,
    usedTokens: 0,
    contextSize: 0,
    events: [],
    ...overrides,
  };
}

/** Seed a run + its raw events into the store so the projection has input. */
function seed(e: AcpRunEntry, events: AcpRunRawEvent[]) {
  useAcpRunStore.setState({
    ...freshState(),
    byId: { [e.acpSessionId]: { ...e, events } },
    orderedIds: [e.acpSessionId],
  });
}

beforeEach(() => {
  useAcpRunStore.setState(freshState());
  steerAcpRun.mockClear();
  stopAcpRun.mockClear();
});

afterEach(cleanup);

describe("AcpRunChatView", () => {
  test("renders chat blocks in order from the seeded store events", () => {
    const e = entry();
    seed(e, [
      {
        seq: 1,
        updateType: "user_message_chunk",
        messageId: "u1",
        content: "fix it",
      },
      {
        seq: 2,
        updateType: "agent_thought_chunk",
        messageId: "t1",
        content: "pondering",
      },
      {
        seq: 3,
        updateType: "agent_message_chunk",
        messageId: "a1",
        content: "on it",
      },
      {
        seq: 4,
        updateType: "tool_call",
        toolCallId: "call-1",
        toolTitle: "Read file",
        toolStatus: "completed",
      },
    ]);

    render(<AcpRunChatView entry={e} onClose={() => {}} />);

    expect(screen.getByTestId("acp-chat-user-turn")).toBeDefined();
    // Thinking block auto-expands while streaming; agent + tool render too.
    expect(screen.getByTestId("acp-chat-thinking-block")).toBeDefined();
    expect(screen.getByTestId("acp-chat-agent-message")).toBeDefined();
    expect(screen.getByTestId("acp-chat-tool-card")).toBeDefined();

    // Order: user before agent before tool in the conversation container.
    const conversation = screen.getByTestId("acp-chat-conversation");
    const html = conversation.innerHTML;
    expect(html.indexOf("acp-chat-user-turn")).toBeLessThan(
      html.indexOf("acp-chat-agent-message"),
    );
    expect(html.indexOf("acp-chat-agent-message")).toBeLessThan(
      html.indexOf("acp-chat-tool-card"),
    );
  });

  test("renders the objective and usage meter in the header", () => {
    const e = entry({ inputTokens: 1000, outputTokens: 200 });
    seed(e, []);

    render(<AcpRunChatView entry={e} onClose={() => {}} />);

    expect(screen.getByTestId("acp-chat-objective").textContent).toContain(
      "Refactor the parser",
    );
    expect(screen.getByTestId("acp-usage-meter")).toBeDefined();
  });

  test("header badge reads 'Cancelled', not 'Completed', for a run cancelled mid-flight", () => {
    const e = entry({ status: "completed", stopReason: "cancelled" });
    seed(e, []);

    render(<AcpRunChatView entry={e} onClose={() => {}} />);

    // The badge previously read the bare status and showed a green "Completed".
    expect(screen.queryByText("Completed")).toBeNull();
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
  });

  test("renders the agent brand mark in the header", () => {
    const e = entry({ agent: "claude" });
    seed(e, []);

    render(<AcpRunChatView entry={e} onClose={() => {}} />);

    expect(
      screen.getByTestId("acp-agent-icon-brand").getAttribute("src"),
    ).toContain("claude.svg");
  });

  test("uses the codex brand mark for a codex agent header", () => {
    const e = entry({ agent: "gpt-5-codex" });
    seed(e, []);

    render(<AcpRunChatView entry={e} onClose={() => {}} />);

    expect(
      screen.getByTestId("acp-agent-icon-brand").getAttribute("src"),
    ).toContain("chatgpt.svg");
  });

  test("shows the steer composer only while running and calls steerAcpRun", () => {
    const e = entry({ status: "running" });
    seed(e, []);

    render(<AcpRunChatView entry={e} onClose={() => {}} />);

    const form = screen.getByTestId("acp-chat-steer-form");
    const input = within(form).getByLabelText("Steering instruction");
    fireEvent.change(input, { target: { value: "use the new API" } });
    fireEvent.submit(form);

    expect(steerAcpRun).toHaveBeenCalledTimes(1);
    expect(steerAcpRun).toHaveBeenCalledWith("acp-1", "use the new API");

    // Optimistic local marker projects as a user turn immediately.
    expect(screen.getByText("use the new API")).toBeDefined();
  });

  test("hides the steer composer when the run is terminal", () => {
    const e = entry({ status: "completed" });
    seed(e, []);

    render(<AcpRunChatView entry={e} onClose={() => {}} />);

    expect(screen.queryByTestId("acp-chat-steer-form")).toBeNull();
  });

  test("opens FileDiffView from a tool-card file chip and Back restores the conversation", () => {
    const e = entry();
    const content = JSON.stringify([
      { type: "diff", path: "src/parser.ts", oldText: "old", newText: "new" },
    ]);
    seed(e, [
      {
        seq: 1,
        updateType: "tool_call",
        toolCallId: "call-1",
        toolTitle: "Edit file",
        toolStatus: "completed",
        content,
      },
    ]);

    render(<AcpRunChatView entry={e} onClose={() => {}} />);

    // Conversation visible; no diff yet.
    expect(screen.getByTestId("acp-chat-conversation")).toBeDefined();
    expect(screen.queryByTestId("acp-chat-diff-back")).toBeNull();

    fireEvent.click(screen.getByTestId("acp-chat-tool-file-chip"));

    // Diff replaces the conversation, and the steer composer is hidden beneath
    // it (gated on the open-diff selection, not the derived diff data).
    expect(screen.getByTestId("acp-chat-diff-back")).toBeDefined();
    expect(screen.queryByTestId("acp-chat-conversation")).toBeNull();
    expect(screen.getByText("src/parser.ts")).toBeDefined();
    expect(screen.queryByTestId("acp-chat-steer-form")).toBeNull();

    // Back restores the conversation and the composer.
    fireEvent.click(screen.getByTestId("acp-chat-diff-back"));
    expect(screen.getByTestId("acp-chat-conversation")).toBeDefined();
    expect(screen.queryByTestId("acp-chat-diff-back")).toBeNull();
    expect(screen.getByTestId("acp-chat-steer-form")).toBeDefined();
  });

  test("opens the command output panel from a tool card and Back restores the conversation", () => {
    const e = entry();
    const content = JSON.stringify([
      {
        type: "content",
        content: { type: "text", text: "```console\nbuild ok\n```" },
      },
    ]);
    seed(e, [
      {
        seq: 1,
        updateType: "tool_call",
        toolCallId: "call-2",
        toolTitle: "Terminal",
        toolKind: "execute",
        toolStatus: "completed",
        content,
      },
    ]);

    render(<AcpRunChatView entry={e} onClose={() => {}} />);
    expect(screen.getByTestId("acp-chat-conversation")).toBeDefined();

    fireEvent.click(screen.getByTestId("acp-chat-tool-output-open"));

    // The output panel replaces the conversation; Back shows; composer hidden.
    expect(screen.getByTestId("acp-chat-command-output")).toBeDefined();
    expect(screen.queryByTestId("acp-chat-conversation")).toBeNull();
    expect(screen.getByTestId("acp-chat-diff-back")).toBeDefined();
    expect(screen.queryByTestId("acp-chat-steer-form")).toBeNull();
    expect(screen.getByTestId("acp-chat-command-output").textContent).toContain(
      "build ok",
    );

    fireEvent.click(screen.getByTestId("acp-chat-diff-back"));
    expect(screen.getByTestId("acp-chat-conversation")).toBeDefined();
    expect(screen.queryByTestId("acp-chat-command-output")).toBeNull();
  });

  test("keeps the open file diff synced as tool_call_update content streams in", () => {
    const e = entry();
    seed(e, [
      {
        seq: 1,
        updateType: "tool_call",
        toolCallId: "call-1",
        toolTitle: "Edit file",
        toolStatus: "in_progress",
        content: JSON.stringify([
          {
            type: "diff",
            path: "src/parser.ts",
            oldText: "before",
            newText: "after-v1",
          },
        ]),
      },
    ]);

    render(<AcpRunChatView entry={e} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("acp-chat-tool-file-chip"));
    // Open diff shows the first snapshot.
    expect(screen.getByText("after-v1")).toBeDefined();

    // A later tool_call_update replaces the tool's content while the diff is open.
    act(() => {
      useAcpRunStore.getState().receiveEvent({
        acpSessionId: "acp-1",
        event: {
          seq: 2,
          updateType: "tool_call_update",
          toolCallId: "call-1",
          toolStatus: "completed",
          content: JSON.stringify([
            {
              type: "diff",
              path: "src/parser.ts",
              oldText: "before",
              newText: "after-v2",
            },
          ]),
        },
      });
    });

    // The open diff re-derives from the live blocks — no Back/reopen needed.
    expect(screen.getByText("after-v2")).toBeDefined();
    expect(screen.queryByText("after-v1")).toBeNull();
    expect(screen.getByTestId("acp-chat-diff-back")).toBeDefined();
  });

  test("renders the terminal block when the run has a terminal status", () => {
    const e = entry({ status: "completed", stopReason: "end_turn" });
    seed(e, []);

    render(<AcpRunChatView entry={e} onClose={() => {}} />);

    const terminal = screen.getByTestId("acp-chat-terminal-block");
    expect(terminal.getAttribute("data-terminal-kind")).toBe("completed");
  });

  test("calls stopAcpRun when Stop is pressed while running", () => {
    const e = entry({ status: "running" });
    seed(e, []);

    render(<AcpRunChatView entry={e} onClose={() => {}} />);

    fireEvent.click(screen.getByLabelText("Stop run"));
    expect(stopAcpRun).toHaveBeenCalledWith("acp-1");
  });

  test("resets run-specific local state when the session switches", () => {
    const first = entry({ acpSessionId: "acp-1", status: "running" });
    seed(first, []);

    const { container, rerender } = render(
      <AcpRunChatView entry={first} onClose={() => {}} />,
    );
    const view = within(container);

    // Dirty the run-specific subcomponent state: type a steer instruction.
    const input = within(
      view.getByTestId("acp-chat-steer-form"),
    ).getByLabelText("Steering instruction") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "leftover instruction" } });
    expect(input.value).toBe("leftover instruction");

    // Switch the drawer to a different ACP run.
    const second = entry({ acpSessionId: "acp-2", status: "running" });
    seed(second, []);
    rerender(<AcpRunChatView entry={second} onClose={() => {}} />);

    // Composer remounts fresh (keyed on acpSessionId): no stale input.
    const nextInput = within(
      view.getByTestId("acp-chat-steer-form"),
    ).getByLabelText("Steering instruction") as HTMLInputElement;
    expect(nextInput.value).toBe("");

    // Header remounts fresh: the Stop button is not stuck disabled from the
    // previous run's `stopping` state.
    expect(
      (view.getByLabelText("Stop run") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("hides the streaming indicator on a trailing live block when terminal", () => {
    // A run that ends right after an agent_message_chunk: the projection leaves
    // the trailing agent block isComplete=false, but the view treats it as
    // complete because the run status is terminal.
    const e = entry({ status: "completed", stopReason: "end_turn" });
    seed(e, [
      {
        seq: 1,
        updateType: "agent_message_chunk",
        messageId: "a1",
        content: "all done",
      },
    ]);

    render(<AcpRunChatView entry={e} onClose={() => {}} />);

    expect(screen.getByTestId("acp-chat-agent-message")).toBeDefined();
    // No live caret / ThreeDotIndicator because the run is terminal.
    expect(screen.queryByTestId("acp-chat-agent-streaming")).toBeNull();
  });
});
