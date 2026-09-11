/**
 * Pins the two shapes a Claude auth failure travels in, plus the
 * wire-contract literals. Losing either shape silently degrades an actionable
 * "reconnect Claude" failure into an opaque one.
 */

import { describe, expect, test } from "bun:test";

import { RequestError } from "@agentclientprotocol/sdk";

import { AcpAuthRequiredEventSchema } from "../../api/events/acp-auth-required.js";
import { AcpSessionErrorEventSchema } from "../../api/events/acp-session-error.js";
import {
  ACP_CLAUDE_AUTH_REQUIRED_CODE,
  AcpAuthRequiredError,
  AUTH_REQUIRED_CODE,
  CLAUDE_ACP_COMMAND,
  isAcpAuthRequired,
  isClaudeAuthFailureMessage,
  requestErrorReason,
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

describe("requestErrorReason", () => {
  test("decodes the sentence the SDK moved into the payload", () => {
    const rejection = new RequestError(-32603, "Internal error", {
      details: "Failed to authenticate. Please run /login",
    });

    expect(requestErrorReason(rejection)).toBe(
      "Failed to authenticate. Please run /login",
    );
    // The point of decoding: the generic message never matches.
    expect(isClaudeAuthFailureMessage(rejection.message)).toBe(false);
    expect(isClaudeAuthFailureMessage(requestErrorReason(rejection))).toBe(
      true,
    );
  });

  test("reads the message off a rejection that carries no payload", () => {
    // Straight off the wire: a plain object, not an instance of any class we
    // control, and with the auth text where the SDK leaves a framed one.
    const rejection = {
      code: -32603,
      message: "Failed to authenticate. Please run /login",
    };

    expect(requestErrorReason(rejection)).toBe(
      "Failed to authenticate. Please run /login",
    );
    expect(isClaudeAuthFailureMessage(requestErrorReason(rejection))).toBe(
      true,
    );
  });

  test("keeps the rejection's own message when the payload names no reason", () => {
    expect(requestErrorReason(new RequestError(-32603, "boom", { c: 7 }))).toBe(
      "boom",
    );
    expect(
      requestErrorReason(
        RequestError.methodNotFound("session/set_config_option"),
      ),
    ).toBe('"Method not found": session/set_config_option');
    expect(requestErrorReason(new Error("Not logged in"))).toBe(
      "Not logged in",
    );
  });

  test("keeps a specific rejection message ahead of supplemental details", () => {
    expect(
      requestErrorReason(
        new RequestError(-32603, "Model unavailable", {
          details: "The selected deployment is temporarily unavailable",
        }),
      ),
    ).toBe("Model unavailable");
  });

  test("serializes the payload behind a bare Internal error that names no reason", () => {
    expect(
      requestErrorReason(new RequestError(-32603, "Internal error", { c: 7 })),
    ).toBe('{"c":7}');
  });

  test("serializes the payload behind a generic Invalid params", () => {
    // How the agent-side SDK answers a request its schema rejects.
    expect(
      requestErrorReason(
        RequestError.invalidParams({ _errors: ["model: Invalid option"] }),
      ),
    ).toBe('{"_errors":["model: Invalid option"]}');
  });

  test("decodes claude-agent-acp's prompt-time 401 from its message", () => {
    // RequestError.internalError({ errorKind }, cliText) as the adapter raises
    // it: the CLI's text rides the message and the payload only names a kind.
    const rejection = new RequestError(
      -32603,
      "Internal error: Failed to authenticate. API Error: 401 OAuth access token has expired.",
      { errorKind: "authentication_failed" },
    );

    expect(requestErrorReason(rejection)).toBe(rejection.message);
    expect(isClaudeAuthFailureMessage(requestErrorReason(rejection))).toBe(
      true,
    );
  });

  test("stringifies a rejection that is not an object at all", () => {
    expect(requestErrorReason("plain string")).toBe("plain string");
    expect(requestErrorReason(-32603)).toBe("-32603");
    expect(requestErrorReason(null)).toBe("null");
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
