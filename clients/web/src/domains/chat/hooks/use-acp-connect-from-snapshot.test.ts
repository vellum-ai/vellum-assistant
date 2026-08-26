/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Re-raising the inline Connect card from the ACP snapshot.
 *
 * The snapshot row is the authoritative source: it carries the credential
 * failure, the conversation that owns it and the spawning tool call the card
 * anchors to, and the daemon clears the failure when a replacement token is
 * stored. These pin the rules the reopen path depends on.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { useInteractionStore } from "@/domains/chat/interaction-store";
import { ACP_CLAUDE_AUTH_REQUIRED_CODE } from "@/domains/chat/utils/acp-connect";
import { raiseAcpConnectFromSnapshot } from "@/domains/chat/hooks/use-acp-run-rehydration";

function run(overrides: Record<string, unknown> = {}) {
  return {
    acpSessionId: "acp-1",
    parentConversationId: "conv-1",
    parentToolUseId: "tool-1",
    status: "failed",
    authErrorCode: ACP_CLAUDE_AUTH_REQUIRED_CODE,
    ...overrides,
  } as any;
}

describe("raiseAcpConnectFromSnapshot", () => {
  beforeEach(() => {
    useInteractionStore.setState({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: new Set<string>(),
    });
  });

  test("raises the card anchored to the run's spawn call and conversation", () => {
    raiseAcpConnectFromSnapshot([run()]);

    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "tool-1",
      reason: "auth_required",
      conversationId: "conv-1",
    });
  });

  test("ignores a run the daemon cleared the failure from", () => {
    // The clear happens on a replacement token write, which is what stops a
    // repaired rejection from re-raising on every reopen.
    raiseAcpConnectFromSnapshot([run({ authErrorCode: undefined })]);

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("ignores a run the user stopped", () => {
    raiseAcpConnectFromSnapshot([run({ status: "cancelled" })]);

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("ignores a run with no spawn call to anchor to", () => {
    raiseAcpConnectFromSnapshot([run({ parentToolUseId: undefined })]);

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("does not resurrect a prompt retired this session", () => {
    useInteractionStore.setState({
      dismissedAcpConnectToolUseIds: new Set(["tool-1"]),
    });

    raiseAcpConnectFromSnapshot([run()]);

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("the newest failure wins when the snapshot holds several", () => {
    // The snapshot arrives newest-first, so the newest marked run is the one
    // the loop must stop on. Ordered the way the route actually returns it.
    raiseAcpConnectFromSnapshot([
      run({ acpSessionId: "acp-2", parentToolUseId: "tool-new" }),
      run({ acpSessionId: "acp-1", parentToolUseId: "tool-old" }),
    ]);

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-new",
    );
  });

  test("skips ineligible newer rows to reach the newest marked one", () => {
    raiseAcpConnectFromSnapshot([
      run({ acpSessionId: "acp-3", authErrorCode: undefined }),
      run({ acpSessionId: "acp-2", parentToolUseId: "tool-new" }),
      run({ acpSessionId: "acp-1", parentToolUseId: "tool-old" }),
    ]);

    expect(useInteractionStore.getState().pendingAcpConnect?.toolUseId).toBe(
      "tool-new",
    );
  });
});
