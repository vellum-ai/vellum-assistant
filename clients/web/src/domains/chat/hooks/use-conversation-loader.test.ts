import { beforeEach, describe, expect, test } from "bun:test";

import { applyConversationSwitch } from "@/domains/chat/hooks/use-conversation-loader";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

const NOW = 1700000000000;
const ACTIVE_CONVERSATION_ID = "conv-active";

function seedRunningState() {
  useSubagentStore.getState().spawnSubagent({
    subagentId: "sub-1",
    label: "sub-1",
    objective: "",
    timestamp: NOW,
    status: "running",
  });
  useWorkflowStore.getState().startRun({ runId: "run-1", timestamp: NOW });
}

function navigateSpy() {
  const calls: string[] = [];
  return { calls, navigate: (path: string) => void calls.push(path) };
}

beforeEach(() => {
  useSubagentStore.getState().reset();
  useWorkflowStore.getState().reset();
  useConversationStore
    .getState()
    .setActiveConversationId(ACTIVE_CONVERSATION_ID);
  useViewerStore.getState().setMainView("app");
  seedRunningState();
});

describe("applyConversationSwitch", () => {
  test("keeps live subagent/workflow state when re-selecting the active conversation", () => {
    const { calls, navigate } = navigateSpy();

    applyConversationSwitch(ACTIVE_CONVERSATION_ID, navigate);

    expect(useSubagentStore.getState().byId["sub-1"]?.status).toBe("running");
    expect(useWorkflowStore.getState().byId["run-1"]).toBeDefined();
    expect(calls).toEqual([]);
    // Side panels still close on a re-click.
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("resets both stores and navigates on a genuine conversation change", () => {
    const { calls, navigate } = navigateSpy();

    applyConversationSwitch("conv-other", navigate);

    expect(useSubagentStore.getState().byId["sub-1"]).toBeUndefined();
    expect(useWorkflowStore.getState().byId["run-1"]).toBeUndefined();
    expect(calls).toEqual([routes.conversation("conv-other")]);
    expect(useViewerStore.getState().mainView).toBe("chat");
  });
});
