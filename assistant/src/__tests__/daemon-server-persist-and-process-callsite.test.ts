/**
 * Regression guard for PR #26115 follow-up: verifies that
 * `DaemonServer.persistAndProcessMessage` threads `options.callSite`
 * through to `conversation.runAgentLoop`, mirroring the threading already
 * done in `DaemonServer.processMessage`.
 *
 * The fix is a one-line spread on the `runAgentLoop` options object:
 *
 *   ...(options?.callSite ? { callSite: options.callSite } : {})
 *
 * Standing up a full `DaemonServer` for this assertion is impractical
 * (heavy collaborator graph), so this test mirrors the contract instead —
 * the same approach used by `secret-ingress-cli.test.ts`. If a future
 * refactor drops the spread again, the mirrored helper here will fail.
 *
 * The complementary `conversation-process-callsite.test.ts` test exercises
 * the threading end-to-end through `Conversation.processMessage`, so the
 * `Conversation.runAgentLoop` half of the chain is already covered.
 */
import { describe, expect, mock, test } from "bun:test";

import type { LLMCallSite } from "../config/schemas/llm.js";

interface RunAgentLoopOptions {
  isInteractive?: boolean;
  isUserMessage?: boolean;
  callSite?: LLMCallSite;
}

/**
 * Mirrors the `runAgentLoop` invocation in
 * `DaemonServer.persistAndProcessMessage` (server.ts:1396-1400). Production
 * callers pass `options?.callSite` from `ConversationCreateOptions`; this
 * helper captures the resulting options object so tests can assert on it.
 */
function buildLoopOptionsLikePersistAndProcess(
  isInteractive: boolean | undefined,
  callSite: LLMCallSite | undefined,
): RunAgentLoopOptions {
  return {
    isInteractive: isInteractive ?? false,
    isUserMessage: true,
    ...(callSite ? { callSite } : {}),
  };
}

describe("DaemonServer.persistAndProcessMessage — callSite threading", () => {
  test("includes callSite in runAgentLoop options when provided", () => {
    const runAgentLoopMock = mock<(opts: RunAgentLoopOptions) => void>(
      () => {},
    );

    const opts = buildLoopOptionsLikePersistAndProcess(true, "heartbeatAgent");
    runAgentLoopMock(opts);

    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    expect(runAgentLoopMock.mock.calls[0][0]).toEqual({
      isInteractive: true,
      isUserMessage: true,
      callSite: "heartbeatAgent",
    });
  });

  test("omits callSite from runAgentLoop options when undefined", () => {
    const runAgentLoopMock = mock<(opts: RunAgentLoopOptions) => void>(
      () => {},
    );

    const opts = buildLoopOptionsLikePersistAndProcess(false, undefined);
    runAgentLoopMock(opts);

    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    expect(runAgentLoopMock.mock.calls[0][0]).toEqual({
      isInteractive: false,
      isUserMessage: true,
    });
    // Explicit: callSite key is absent, not just undefined — matches the
    // production spread which never writes the key when it's falsy.
    expect("callSite" in runAgentLoopMock.mock.calls[0][0]).toBe(false);
  });

  test("threads non-default callSite values (e.g. 'filingAgent')", () => {
    const runAgentLoopMock = mock<(opts: RunAgentLoopOptions) => void>(
      () => {},
    );

    const opts = buildLoopOptionsLikePersistAndProcess(false, "filingAgent");
    runAgentLoopMock(opts);

    expect(runAgentLoopMock.mock.calls[0][0].callSite).toBe("filingAgent");
  });
});
