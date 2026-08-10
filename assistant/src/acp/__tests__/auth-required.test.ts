/**
 * Tests for the ACP auth-required signal.
 *
 * The point of this module is that the classification survives its trip from
 * the agent's JSON-RPC rejection to the session manager, where it becomes an
 * event the UI can act on. These pin both shapes it travels in, because losing
 * either one silently degrades an actionable "reconnect Claude" failure back
 * into an opaque one.
 */

import { describe, expect, test } from "bun:test";

import { AcpAuthRequiredEventSchema } from "../../api/events/acp-auth-required.js";
import { AcpSessionErrorEventSchema } from "../../api/events/acp-session-error.js";
import {
  ACP_CLAUDE_AUTH_REQUIRED_CODE,
  AcpAuthRequiredError,
  AUTH_REQUIRED_CODE,
  CLAUDE_ACP_COMMAND,
  isAcpAuthRequired,
} from "../auth-required.js";

describe("isAcpAuthRequired", () => {
  test("recognizes the raw JSON-RPC rejection from the agent", () => {
    // What the adapter actually sends: a plain object off the wire, not an
    // instance of any class we control.
    expect(isAcpAuthRequired({ code: AUTH_REQUIRED_CODE })).toBe(true);
  });

  test("recognizes our own error after the retry path gives up", () => {
    expect(isAcpAuthRequired(new AcpAuthRequiredError("claude", "nope"))).toBe(
      true,
    );
  });

  test("does not fire on other failures", () => {
    expect(isAcpAuthRequired(new Error("Internal error"))).toBe(false);
    expect(isAcpAuthRequired({ code: -32601 })).toBe(false);
    expect(isAcpAuthRequired(null)).toBe(false);
    expect(isAcpAuthRequired(undefined)).toBe(false);
    expect(isAcpAuthRequired("auth_required")).toBe(false);
  });

  test("uses the ACP-specified code", () => {
    // Matches the SDK's RequestError.authRequired(); drifting from it would
    // silently stop classifying every auth failure.
    expect(AUTH_REQUIRED_CODE).toBe(-32000);
  });
});

describe("AcpAuthRequiredError", () => {
  test("is an Error that carries the agent id and its message", () => {
    const err = new AcpAuthRequiredError("claude", "needs a reconnect");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AcpAuthRequiredError");
    expect(err.agentId).toBe("claude");
    expect(err.message).toBe("needs a reconnect");
  });
});

describe("event shape is additive-safe for older clients", () => {
  test("acp_session_error rejects unknown keys, which is why the signal is not a field on it", () => {
    // Clients parse with AssistantEventSchema.safeParse and fall back to an
    // inert `unknown` event when it fails. A packaged client (iOS and macOS
    // bundle the web app, so they can lag the daemon) carries whatever version
    // of this schema it shipped with. Adding a field here would make such a
    // client drop the whole event and leave the run rendering as still active,
    // which is worse than the plain failure. This asserts the strictness that
    // forces new signals into their own event type instead.
    const result = AcpSessionErrorEventSchema.safeParse({
      type: "acp_session_error",
      acpSessionId: "acp-1",
      error: "boom",
      someFutureField: "x",
    });
    expect(result.success).toBe(false);
  });

  test("acp_session_error still parses in its unchanged shape", () => {
    expect(
      AcpSessionErrorEventSchema.safeParse({
        type: "acp_session_error",
        acpSessionId: "acp-1",
        error: "boom",
      }).success,
    ).toBe(true);
  });

  test("acp_auth_required carries the code and an optional anchor", () => {
    const parsed = AcpAuthRequiredEventSchema.parse({
      type: "acp_auth_required",
      acpSessionId: "acp-1",
      authCode: ACP_CLAUDE_AUTH_REQUIRED_CODE,
      agent: "claude",
      parentToolUseId: "tool-1",
    });
    expect(parsed.authCode).toBe(ACP_CLAUDE_AUTH_REQUIRED_CODE);
    expect(parsed.parentToolUseId).toBe("tool-1");

    // The anchor is optional: a run not started by a tool call has none.
    expect(
      AcpAuthRequiredEventSchema.safeParse({
        type: "acp_auth_required",
        acpSessionId: "acp-1",
        authCode: ACP_CLAUDE_AUTH_REQUIRED_CODE,
        agent: "claude",
      }).success,
    ).toBe(true);
  });
});

describe("wire contract", () => {
  test("the client marker matches the web literal", () => {
    // Paired with ACP_CLAUDE_AUTH_REQUIRED_CODE in
    // clients/web/src/domains/chat/utils/acp-connect.ts. A silent rename on
    // either side turns the Connect card off with nothing failing.
    expect(ACP_CLAUDE_AUTH_REQUIRED_CODE).toBe("acp_claude_auth_required");
  });

  test("the adapter gate matches the resolved command basename", () => {
    // Compared against SessionEntry.command, which is already a basename.
    expect(CLAUDE_ACP_COMMAND).toBe("claude-agent-acp");
  });
});
