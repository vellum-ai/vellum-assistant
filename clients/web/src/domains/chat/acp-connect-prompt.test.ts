/**
 * Regression tests for the "Connect Claude Code" prompt lifecycle.
 *
 * The prompt for a missing-token `acp_spawn` failure lives in the interaction
 * store. It is raised from the LIVE `tool_result` stream handler and — so it
 * survives a page reload / SSE reconnect — re-derived on a `/messages` reseed
 * from the failed tool call's persisted `errorCode` marker (via
 * `extractWirePendingAcpConnect`, exercised in `utils/chat.test.ts`). Two
 * invariants are pinned here: (1) the rolling-snapshot reducer
 * (`appendEventToMessages`) must NEVER touch the interaction store — folding
 * the event tail on reseed can't clear the live prompt mid-turn or raise a
 * duplicate; rehydration is the reseed hook's job, not the reducer's. (2) A
 * dismissed failure must not nag from history: `dismissAcpConnect` records the
 * tool-use id and `showAcpConnect` no-ops any later restore of it, which is
 * what makes reseed-rehydration of the permanent `errorCode` marker safe.
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

  test("a dismissed failure is not resurrected by a later restore (no history nag)", () => {
    // Card shown, then dismissed (an explicit X or the implicit dismiss-on-send).
    useInteractionStore.getState().showAcpConnect({ toolUseId: "tc-1" });
    useInteractionStore.getState().dismissAcpConnect();
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();

    // A reseed re-derives the SAME failed spawn from its persisted marker and
    // calls showAcpConnect again — it must no-op, or the card would nag on
    // every turn until Claude is connected.
    useInteractionStore.getState().showAcpConnect({ toolUseId: "tc-1" });
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("a genuinely new failure still shows after a different one was dismissed", () => {
    useInteractionStore.getState().showAcpConnect({ toolUseId: "tc-1" });
    useInteractionStore.getState().dismissAcpConnect();

    // A new spawn failure carries a fresh tool-use id → never suppressed.
    useInteractionStore.getState().showAcpConnect({ toolUseId: "tc-2" });
    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "tc-2",
    });
  });

  test("resetAll clears the dismissed set (a returned-to conversation can show again)", () => {
    useInteractionStore.getState().showAcpConnect({ toolUseId: "tc-1" });
    useInteractionStore.getState().dismissAcpConnect();
    useInteractionStore.getState().resetAll();

    // After a conversation switch the suppression is cleared, so a cold reseed
    // of the same conversation restores the card (matches "cold reload shows").
    useInteractionStore.getState().showAcpConnect({ toolUseId: "tc-1" });
    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "tc-1",
    });
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

  test("the reseed reducer never touches the store, so a live prompt survives reseed", () => {
    // Live failure raises the prompt.
    handleToolResult(missingTokenToolResult(), stubCtx());
    expect(useInteractionStore.getState().pendingAcpConnect).not.toBeNull();

    // A `/messages` reseed replays the event tail through the reducer. Folding
    // the SAME missing-token tool_result through `appendEventToMessages` (the
    // reducer path) must NOT touch the interaction store — otherwise it would
    // clear the live prompt mid-turn or raise a duplicate. Rehydration on a
    // cold reload is the reseed hook's job (`extractWirePendingAcpConnect`),
    // not the reducer's.
    const messages: DisplayMessage[] = [];
    appendEventToMessages(
      messages,
      missingTokenToolResult() as unknown as AssistantEvent,
      1,
    );

    // Prompt still exactly as the live handler left it — the reducer didn't
    // clear it (survives mid-turn) and didn't re-raise it (no duplicate).
    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "tc-1",
    });
  });

  test("reducer replay alone (fresh store) leaves the prompt unset — rehydration is the reseed hook's job", () => {
    // The reducer path never sets the prompt. On a real reload the reseed hook
    // (`extractWirePendingAcpConnect`, covered in utils/chat.test.ts) restores
    // it from the persisted marker; the reducer alone must stay a no-op so the
    // two paths don't double-raise.
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
    appendEventToMessages(
      [],
      missingTokenToolResult() as unknown as AssistantEvent,
      1,
    );
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });
});
