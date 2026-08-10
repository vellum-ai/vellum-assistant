/**
 * Pins the two shapes a Claude auth failure travels in, plus the
 * wire-contract literals. Losing either shape silently degrades an actionable
 * "reconnect Claude" failure into an opaque one.
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
  isClaudeAuthFailureMessage,
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

describe("isClaudeAuthFailureMessage", () => {
  test("matches the live rejected-credential failure verbatim", () => {
    // Captured from a real claude-agent-acp run against a revoked token: the
    // adapter relays the CLI's failure as a -32603 internal error carrying
    // this text, NOT as the structured auth_required rejection. This message
    // is the reported bug, so it must classify.
    expect(
      isClaudeAuthFailureMessage(
        "Internal error: Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
      ),
    ).toBe(true);
  });

  test("is insensitive to the server's variable suffix", () => {
    // The CLI-authored prefix is the stable part; the API's suffix varies.
    expect(
      isClaudeAuthFailureMessage(
        "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
      ),
    ).toBe(true);
  });

  test("matches the CLI's other auth phrasings", () => {
    expect(
      isClaudeAuthFailureMessage(
        "Session expired. Please run /login to sign in again.",
      ),
    ).toBe(true);
    expect(isClaudeAuthFailureMessage("Not logged in")).toBe(true);
  });

  test("does not fire on ordinary failures", () => {
    expect(isClaudeAuthFailureMessage("Internal error")).toBe(false);
    expect(isClaudeAuthFailureMessage("ECONNRESET: connection reset")).toBe(
      false,
    );
    expect(
      isClaudeAuthFailureMessage("Command failed: login.sh: not found"),
    ).toBe(false);
    expect(isClaudeAuthFailureMessage(undefined)).toBe(false);
    expect(isClaudeAuthFailureMessage("")).toBe(false);
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
    // Clients drop a whole event over an unknown key (strict schemas plus a
    // safeParse fallback to `unknown`), so new signals must ride new event
    // types; this pins the strictness that forces that.
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
