/**
 * History restore of the inline Connect Claude Code card.
 *
 * Ordinary missing-token markers wait for a connected-status check before the
 * interaction store is touched. `auth_required` raises immediately. A
 * connected workspace neither raises nor records a dismissal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { restoreAcpConnectFromHistory } from "@/domains/chat/hooks/restore-acp-connect-from-history";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import {
  ACP_CLAUDE_AUTH_REQUIRED_CODE,
  ACP_CLAUDE_OAUTH_MISSING_CODE,
} from "@/domains/chat/utils/acp-connect";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { clearUserScopedOverrides } from "@/utils/typed-storage";

function messagesWithMarker(
  errorCode: string,
  toolUseId = "toolu-acp-1",
): DisplayMessage[] {
  return [
    {
      id: "msg-1",
      role: "assistant",
      toolCalls: [
        {
          id: toolUseId,
          name: "acp_spawn",
          input: { agent: "claude" },
          isError: true,
          errorCode,
        },
      ],
    },
  ];
}

function restore(overrides: {
  messages?: DisplayMessage[];
  isCurrent?: () => boolean;
  checkConnected?: (assistantId: string) => Promise<boolean>;
  revisionAtRestore?: number;
  conversationId?: string;
} = {}) {
  return restoreAcpConnectFromHistory({
    messages:
      overrides.messages ?? messagesWithMarker(ACP_CLAUDE_OAUTH_MISSING_CODE),
    assistantId: "asst-1",
    conversationId: overrides.conversationId ?? "conv-A",
    revisionAtRestore:
      overrides.revisionAtRestore ??
      useInteractionStore.getState().acpConnectRevision,
    isCurrent: overrides.isCurrent ?? (() => true),
    checkConnected: overrides.checkConnected,
  });
}

function resetStore() {
  useInteractionStore.getState().resetAll();
  useInteractionStore.setState({
    pendingAcpConnect: null,
    dismissedAcpConnectToolUseIds: new Set<string>(),
  });
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  resetStore();
  localStorage.clear();
  clearUserScopedOverrides();
});

describe("restoreAcpConnectFromHistory", () => {
  test("does not raise while the connected-status check is pending", async () => {
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });

    const done = restore({
      checkConnected: () => pending,
    });

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
    expect(
      useInteractionStore.getState().dismissedAcpConnectToolUseIds.size,
    ).toBe(0);

    release(false);
    await done;
  });

  test("connected true neither raises nor records a dismissal", async () => {
    await restore({
      checkConnected: async () => true,
    });

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
    expect(
      useInteractionStore.getState().dismissedAcpConnectToolUseIds.size,
    ).toBe(0);
  });

  test("connected false raises the captured missing-token prompt", async () => {
    await restore({
      checkConnected: async () => false,
    });

    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "toolu-acp-1",
      conversationId: "conv-A",
    });
  });

  test("a thrown check raises", async () => {
    await restore({
      checkConnected: async () => {
        throw new Error("route unavailable");
      },
    });

    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "toolu-acp-1",
      conversationId: "conv-A",
    });
  });

  test("auth_required raises immediately without checking presence", async () => {
    let checked = false;

    await restore({
      messages: messagesWithMarker(ACP_CLAUDE_AUTH_REQUIRED_CODE),
      checkConnected: async () => {
        checked = true;
        return true;
      },
    });

    expect(checked).toBe(false);
    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "toolu-acp-1",
      reason: "auth_required",
      conversationId: "conv-A",
    });
  });

  test("a newer live prompt raised during the await is not overwritten", async () => {
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });

    const done = restore({
      checkConnected: () => pending,
    });

    useInteractionStore.getState().showAcpConnect({
      toolUseId: "toolu-live",
      reason: "auth_required",
      conversationId: "conv-A",
    });

    release(false);
    await done;

    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "toolu-live",
      reason: "auth_required",
      conversationId: "conv-A",
    });
  });

  test("a superseded snapshot cannot raise after its await resolves", async () => {
    let current = true;
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });

    const done = restore({
      checkConnected: () => pending,
      isCurrent: () => current,
    });

    current = false;
    release(false);
    await done;

    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });
});
