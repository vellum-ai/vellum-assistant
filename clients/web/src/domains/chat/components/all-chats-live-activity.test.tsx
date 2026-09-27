import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";

mock.module("@/domains/chat/components/conversation-activity-chips", () => ({
  ConversationActivityChips: () => null,
}));

const { AllChatsLiveActivity } = await import("./all-chats-live-activity");
const { useSubagentStore } = await import("@/domains/chat/subagent-store");
const { useAcpRunStore } = await import("@/domains/chat/acp-run-store");
const { useBackgroundTaskStore } =
  await import("@/domains/chat/background-task-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { AllChatsRow } = await import("@/domains/chat/pages/all-chats-page");
const { ConversationListProvider } =
  await import("./conversation-list-context");

afterEach(() => {
  cleanup();
  useSubagentStore.getState().reset();
  useAcpRunStore.getState().reset();
  useBackgroundTaskStore.getState().reset();
  useConversationStore.setState({
    processingConversationIds: new Set(),
    attentionConversationIds: new Set(),
  });
});

function spawn(id: string, parentConversationId?: string) {
  useSubagentStore.getState().spawnSubagent({
    subagentId: id,
    parentConversationId,
    timestamp: 1,
    label: "Example agent",
    objective: "Review a document",
    status: "running",
  });
}

test("focused rows describe unread state and current activity, including completion", () => {
  spawn("agent-1", "conv-1");
  spawn("agent-2", "conv-1");
  const conversation = {
    conversationId: "conv-1",
    title: "Example chat",
    hasUnseenLatestAssistantMessage: true,
  };
  const view = render(
    <ConversationListProvider value={{ onSelect: () => {} }}>
      <AllChatsRow
        conversation={conversation}
        now={new Date(2026, 8, 24)}
        activity={<AllChatsLiveActivity conversation={conversation} />}
      />
    </ConversationListProvider>,
  );
  const row = view.getByRole("button", {
    name: "Example chat",
    description: "Unread 2 running tasks",
  });
  row.focus();
  act(() =>
    useSubagentStore.getState().changeStatus({
      subagentId: "agent-1",
      status: "awaiting_input",
    }),
  );
  expect(
    view.getByRole("button", {
      name: "Example chat",
      description: "Unread Needs attention",
    }),
  ).toBe(row);
  act(() => {
    for (const subagentId of ["agent-1", "agent-2"]) {
      useSubagentStore
        .getState()
        .changeStatus({ subagentId, status: "completed" });
    }
  });
  expect(
    view.getByRole("button", {
      name: "Example chat",
      description: /^Unread\s*$/,
    }),
  ).toBe(row);
  expect(document.activeElement).toBe(row);
});

test("shows only the owning chat's tasks, excluding unknown parents", () => {
  spawn("agent-1", "conv-1");
  spawn("agent-2", "conv-2");
  spawn("agent-unknown");
  const view = render(
    <AllChatsLiveActivity conversation={{ conversationId: "conv-1" }} />,
  );
  expect(view.getByRole("status").getAttribute("aria-label")).toBe(
    "1 running task",
  );
  view.rerender(
    <AllChatsLiveActivity conversation={{ conversationId: "conv-3" }} />,
  );
  expect(view.queryByRole("status")).toBeNull();
});

test("clears a running badge on completion without opening the chat", () => {
  spawn("agent-1", "conv-1");
  const view = render(
    <AllChatsLiveActivity conversation={{ conversationId: "conv-1" }} />,
  );
  act(() =>
    useSubagentStore
      .getState()
      .changeStatus({ subagentId: "agent-1", status: "completed" }),
  );
  expect(view.queryByRole("status")).toBeNull();
});

test("counts owned ACP sessions and background tools and drops terminal work", () => {
  for (const [id, parentConversationId] of [
    ["acp-1", "conv-1"],
    ["acp-2", "conv-2"],
    ["acp-unknown", ""],
  ]) {
    useAcpRunStore.getState().spawnRun({
      acpSessionId: id,
      agent: "claude",
      parentConversationId,
      startedAt: 1,
    });
  }
  for (const conversationId of ["conv-1", "conv-2"]) {
    useBackgroundTaskStore.getState().startTask({
      type: "background_tool_started",
      id: `bg-${conversationId}`,
      conversationId,
      toolName: "bash",
      command: "bun run build",
      startedAt: 1,
    });
  }
  const view = render(
    <AllChatsLiveActivity conversation={{ conversationId: "conv-1" }} />,
  );
  expect(view.getByRole("status").getAttribute("aria-label")).toBe(
    "2 running tasks",
  );
  act(() =>
    useAcpRunStore.getState().setTerminal({
      acpSessionId: "acp-1",
      status: "completed",
      completedAt: 2,
    }),
  );
  expect(view.getByRole("status").getAttribute("aria-label")).toBe(
    "1 running task",
  );
  act(() =>
    useBackgroundTaskStore.getState().completeTask({
      type: "background_tool_completed",
      id: "bg-conv-1",
      conversationId: "conv-1",
      status: "completed",
      completedAt: 2,
      exitCode: 0,
      output: "Built",
    }),
  );
  expect(view.queryByRole("status")).toBeNull();
});

test("distinguishes waiting for input from running", () => {
  spawn("agent-1", "conv-1");
  const view = render(
    <AllChatsLiveActivity conversation={{ conversationId: "conv-1" }} />,
  );
  act(() =>
    useSubagentStore
      .getState()
      .changeStatus({ subagentId: "agent-1", status: "awaiting_input" }),
  );
  expect(view.getByRole("status").getAttribute("aria-label")).toBe(
    "Needs attention",
  );
});

test("shows server-seeded processing and live optimistic processing", () => {
  const view = render(
    <AllChatsLiveActivity
      conversation={{ conversationId: "conv-1", isProcessing: true }}
    />,
  );
  expect(view.getByRole("status")).toBeDefined();
  view.rerender(
    <AllChatsLiveActivity conversation={{ conversationId: "conv-1" }} />,
  );
  expect(view.queryByRole("status")).toBeNull();
  act(() =>
    useConversationStore.setState({
      processingConversationIds: new Set(["conv-1"]),
    }),
  );
  expect(view.getByRole("status")).toBeDefined();
});
