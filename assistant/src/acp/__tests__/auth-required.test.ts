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
