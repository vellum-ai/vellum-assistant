/**
 * Tests for the voice draft mint.
 *
 * A call started from a widget button, the Action Button, Control Center, a
 * Siri shortcut or the Talk shortcut opens a conversation that has never
 * existed before, and the app it opens into is sitting on whatever the user
 * was last doing. So the property here is that nothing of that previous
 * conversation comes with it: no side panel about its messages, and no
 * subagent or workflow card from a run that belongs to it. Those cards are not
 * only stale to look at, they are live controls, and a workflow row carried
 * onto a fresh draft can abort a run started somewhere else entirely.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

mock.module("@/lib/sounds/sound-manager", () => ({
  getSoundManager: () => ({ play: () => Promise.resolve() }),
}));

const { mintVoiceDraftConversation } =
  await import("@/domains/chat/voice/voice-draft-conversation");

/** The unrelated thread the app was left sitting on. */
const PRIOR_CONVERSATION_ID = "conv-prior";

beforeEach(() => {
  useViewerStore.getState().reset();
  useConversationStore.getState().reset();
  useSubagentStore.getState().reset();
  useWorkflowStore.getState().reset();
  useConversationStore
    .getState()
    .setActiveConversationId(PRIOR_CONVERSATION_ID);
});

describe("mintVoiceDraftConversation", () => {
  test("selects a fresh draft rather than the conversation the app was left on", () => {
    const draftId = mintVoiceDraftConversation();

    expect(draftId).not.toBe(PRIOR_CONVERSATION_ID);
    expect(useConversationStore.getState().activeConversationId).toBe(draftId);
    expect(
      useConversationStore.getState().draftConversationIds.has(draftId),
    ).toBe(true);
  });

  test("leaves the previous conversation's workflow run behind", () => {
    // A run is addressable from its card: abort, journal. Carried onto a draft
    // that has no such run, it shows and controls somebody else's workflow.
    useWorkflowStore.getState().startRun({
      runId: "run-1",
      label: "nightly audit",
      timestamp: Date.now(),
    });
    expect(useWorkflowStore.getState().orderedIds).toContain("run-1");

    mintVoiceDraftConversation();

    expect(useWorkflowStore.getState().byId["run-1"]).toBeUndefined();
    expect(useWorkflowStore.getState().orderedIds).toEqual([]);
  });

  test("leaves the previous conversation's subagent rows behind", () => {
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sub-1",
      label: "auditor",
      objective: "audit",
      timestamp: Date.now(),
    });

    mintVoiceDraftConversation();

    expect(useSubagentStore.getState().byId["sub-1"]).toBeUndefined();
  });

  test("clears the transcript side panels and brings the chat on screen", () => {
    // On desktop the composer counts as on screen only while the main view is
    // not the fullscreen app viewer, so a draft minted behind it has no
    // composer to speak into.
    useViewerStore.getState().setMainView("app");
    useViewerStore.getState().openMessageFiles({
      messageId: "msg-prior",
      attachments: [],
    });

    mintVoiceDraftConversation();

    expect(useViewerStore.getState().activeMessageFiles).toBeNull();
    expect(useViewerStore.getState().mainView).toBe("chat");
  });
});
