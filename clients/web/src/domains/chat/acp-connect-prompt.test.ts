/**
 * Regression tests for the ephemeral "Connect Claude Code" prompt lifecycle.
 *
 * The prompt for a missing-token `acp_spawn` failure lives in the interaction
 * store, raised from the LIVE `tool_result` stream handler — NOT folded into the
 * rolling-snapshot message list. That split is the whole fix: a routine
 * `/messages` reseed rebuilds the transcript from persisted history (which
 * doesn't carry the tool-call `errorCode` marker) by replaying the event tail
 * through the reducer, so if the reducer raised the prompt it would vanish
 * mid-turn — and if history replayed it, it would nag on reload. These tests pin
 * both halves: the live handler raises it; the reducer never does.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { useInteractionStore } from "@/domains/chat/interaction-store";
import { handleToolResult } from "@/domains/chat/utils/stream-handlers/tool-call-handlers";
import { appendEventToMessages } from "@/domains/chat/transcript/rolling-snapshot";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { AssistantEvent } from "@/types/event-types";
import type { ToolResultEvent } from "@vellumai/assistant-api";

const MISSING_TOKEN = "acp_claude_oauth_missing";

/** A missing-token `acp_spawn` failure event, as the daemon emits it live. */
function missingTokenToolResult(
  overrides: Partial<ToolResultEvent> = {},
): ToolResultEvent {
  return {
    type: "tool_result",
    toolUseId: "tc-1",
    result: "claude-agent-acp requires CLAUDE_CODE_OAUTH_TOKEN.",
    isError: true,
    errorCode: MISSING_TOKEN,
    ...overrides,
  } as ToolResultEvent;
}

/** Minimal stream-handler context — `handleToolResult` only touches turnActions. */
function stubCtx(): StreamHandlerContext {
  return {
    turnActions: {
      onToolResult: () => {},
      onToolActivityMetadata: () => {},
    },
  } as unknown as StreamHandlerContext;
}

afterEach(() => {
  useInteractionStore.getState().resetAll();
});

describe("acp connect prompt — store lifecycle", () => {
  test("showAcpConnect sets, dismissAcpConnect clears", () => {
    useInteractionStore.getState().showAcpConnect({ toolUseId: "tc-9" });
    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "tc-9",
    });

    useInteractionStore.getState().dismissAcpConnect();
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("resetAll clears the prompt (conversation switch)", () => {
    useInteractionStore.getState().showAcpConnect({ toolUseId: "tc-9" });
    useInteractionStore.getState().resetAll();
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });
});

describe("acp connect prompt — raised live, never by reseed", () => {
  test("the live tool_result handler raises the prompt anchored to the tool call", () => {
    handleToolResult(missingTokenToolResult(), stubCtx());
    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "tc-1",
    });
  });

  test("a non-missing-token failure does not raise the prompt", () => {
    handleToolResult(
      missingTokenToolResult({ errorCode: "some_other_error" }),
      stubCtx(),
    );
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("the reseed reducer never raises the prompt, so it survives reseed and is absent on reload", () => {
    // Live failure raises the prompt.
    handleToolResult(missingTokenToolResult(), stubCtx());
    expect(useInteractionStore.getState().pendingAcpConnect).not.toBeNull();

    // A `/messages` reseed replays the event tail through the reducer. Folding
    // the SAME missing-token tool_result through `appendEventToMessages` (the
    // reseed path) must NOT touch the interaction store — otherwise the prompt
    // would be reseed-fragile (vanish) or history-replayed (nag on reload).
    const messages: DisplayMessage[] = [];
    appendEventToMessages(
      messages,
      missingTokenToolResult() as unknown as AssistantEvent,
      1,
    );

    // Prompt still exactly as the live handler left it — the reseed didn't
    // clear it (survives mid-turn) and didn't re-raise it (no reload nag).
    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "tc-1",
    });
  });

  test("reducer replay alone (fresh store, no live event) leaves the prompt unset", () => {
    // Simulates a page reload: the store starts empty and history reseeds via
    // the reducer only. The prompt must stay null — it is never rehydrated from
    // persisted history.
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
    appendEventToMessages(
      [],
      missingTokenToolResult() as unknown as AssistantEvent,
      1,
    );
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });
});
