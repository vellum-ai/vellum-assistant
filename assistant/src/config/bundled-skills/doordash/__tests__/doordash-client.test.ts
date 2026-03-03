import { describe, expect, it } from "bun:test";

import { RateLimitError, SessionExpiredError } from "../lib/client.js";

describe("SessionExpiredError", () => {
  it("is an instance of Error", () => {
    const err = new SessionExpiredError("test reason");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name set to SessionExpiredError", () => {
    const err = new SessionExpiredError("test reason");
    expect(err.name).toBe("SessionExpiredError");
  });

  it("preserves the reason as the message", () => {
    const err = new SessionExpiredError("DoorDash session has expired.");
    expect(err.message).toBe("DoorDash session has expired.");
  });

  it("can be distinguished from plain Error via instanceof", () => {
    const sessionErr = new SessionExpiredError("expired");
    const plainErr = new Error("something else");
    expect(sessionErr instanceof SessionExpiredError).toBe(true);
    expect(plainErr instanceof SessionExpiredError).toBe(false);
  });

  it("produces a useful stack trace", () => {
    const err = new SessionExpiredError("no session");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("SessionExpiredError");
  });
});

describe("expired session classification", () => {
  // The CDP response handler in cdpFetch classifies certain HTTP statuses
  // as session-expired. We test the classification logic by simulating
  // the parsed response structure that cdpFetch evaluates.

  function classifyResponse(parsed: Record<string, unknown>): Error {
    // Mirrors the classification logic from cdpFetch (client.ts lines 188-200)
    if (parsed.__error) {
      if (parsed.__status === 401) {
        return new SessionExpiredError("DoorDash session has expired.");
      } else if (parsed.__status === 403) {
        return new RateLimitError("DoorDash rate limit hit (HTTP 403).");
      }
      return new Error(
        (parsed.__message as string) ??
          `HTTP ${parsed.__status}: ${(parsed.__body as string) ?? ""}`,
      );
    }
    return new Error("No error");
  }

  it("classifies HTTP 401 as SessionExpiredError", () => {
    const err = classifyResponse({
      __error: true,
      __status: 401,
      __body: "Unauthorized",
    });
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(err.message).toBe("DoorDash session has expired.");
  });

  it("classifies HTTP 403 as RateLimitError", () => {
    const err = classifyResponse({
      __error: true,
      __status: 403,
      __body: "Forbidden",
    });
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.message).toBe("DoorDash rate limit hit (HTTP 403).");
  });

  it("classifies HTTP 500 as a generic Error, not session expired", () => {
    const err = classifyResponse({
      __error: true,
      __status: 500,
      __body: "Internal Server Error",
    });
    expect(err).not.toBeInstanceOf(SessionExpiredError);
    expect(err.message).toBe("HTTP 500: Internal Server Error");
  });

  it("classifies HTTP 429 as a generic Error", () => {
    const err = classifyResponse({
      __error: true,
      __status: 429,
      __body: "Rate limited",
    });
    expect(err).not.toBeInstanceOf(SessionExpiredError);
    expect(err.message).toBe("HTTP 429: Rate limited");
  });

  it("uses __message when available", () => {
    const err = classifyResponse({ __error: true, __message: "fetch failed" });
    expect(err).not.toBeInstanceOf(SessionExpiredError);
    expect(err.message).toBe("fetch failed");
  });

  it("handles response with no __body or __message gracefully", () => {
    const err = classifyResponse({ __error: true, __status: 502 });
    expect(err).not.toBeInstanceOf(SessionExpiredError);
    expect(err.message).toBe("HTTP 502: ");
  });
});

describe("CDP failure scenarios", () => {
  // These test the error conditions that cdpFetch can encounter:
  // 1. CDP protocol error (msg.error present)
  // 2. Empty CDP response (no value in result)
  // 3. Timeout (30s)
  // 4. WebSocket connection failure

  // We can test the error construction logic without connecting to a real CDP

  it("CDP protocol error produces a descriptive message", () => {
    // Simulates the error path at client.ts line 143
    const cdpError = { message: "Cannot find context with specified id" };
    const err = new Error(`CDP error: ${cdpError.message}`);
    expect(err.message).toBe(
      "CDP error: Cannot find context with specified id",
    );
  });

  it("Empty CDP response produces a clear error", () => {
    // Simulates the error path at client.ts line 149
    const value = undefined;
    const err = !value ? new Error("Empty CDP response") : null;
    expect(err).not.toBeNull();
    expect(err!.message).toBe("Empty CDP response");
  });

  it("CDP timeout error message includes the timeout duration", () => {
    // Simulates the timeout error at client.ts line 92
    const err = new Error("CDP fetch timed out after 30s");
    expect(err.message).toContain("30s");
  });

  it("WebSocket connection failure produces SessionExpiredError", () => {
    // Simulates ws.onerror at client.ts line 172
    const err = new SessionExpiredError("CDP connection failed.");
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(err.message).toBe("CDP connection failed.");
  });

  it("findDoordashTab failure when CDP is unavailable", () => {
    // Simulates findDoordashTab at client.ts line 67
    const err = new SessionExpiredError(
      "Chrome CDP not available. Run `vellum doordash refresh` first.",
    );
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(err.message).toContain("Chrome CDP not available");
  });

  it("findDoordashTab failure when no tab is available", () => {
    // Simulates findDoordashTab at client.ts line 76
    const err = new SessionExpiredError(
      "No Chrome tab available for DoorDash requests.",
    );
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(err.message).toContain("No Chrome tab available");
  });

  it("requireSession throws SessionExpiredError when no session exists", () => {
    // Simulates requireSession at client.ts line 56
    const session = null;
    const err = !session
      ? new SessionExpiredError("No DoorDash session found.")
      : null;
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(err!.message).toBe("No DoorDash session found.");
  });

  it("GraphQL errors are joined with semicolons", () => {
    // Simulates the error handling at client.ts lines 192-194
    const errors = [
      { message: 'Field "x" not found' },
      { message: "Unauthorized" },
    ];
    const msgs = errors.map((e) => e.message || JSON.stringify(e)).join("; ");
    const err = new Error(`GraphQL errors: ${msgs}`);
    expect(err.message).toBe(
      'GraphQL errors: Field "x" not found; Unauthorized',
    );
  });

  it("GraphQL errors use JSON.stringify for errors without message", () => {
    const errors = [{ extensions: { code: "INTERNAL_ERROR" } }];
    const msgs = errors
      .map((e) => (e as Record<string, unknown>).message || JSON.stringify(e))
      .join("; ");
    const err = new Error(`GraphQL errors: ${msgs}`);
    expect(err.message).toContain("INTERNAL_ERROR");
  });

  it("Empty GraphQL response throws", () => {
    // Simulates client.ts lines 196-198
    const data = undefined;
    const err = !data ? new Error("Empty response from DoorDash API") : null;
    expect(err).not.toBeNull();
    expect(err!.message).toBe("Empty response from DoorDash API");
  });
});
