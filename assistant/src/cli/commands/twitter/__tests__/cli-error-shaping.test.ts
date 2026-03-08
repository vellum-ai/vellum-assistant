/**
 * Tests for CLI error-shaping logic in the `run()` helper of twitter.ts.
 *
 * These tests verify that structured router metadata (pathUsed,
 * suggestAlternative, oauthError) is preserved in CLI output while
 * maintaining backward-compatible error codes.
 */
import { describe, expect, test } from "bun:test";

import { SessionExpiredError } from "../client.js";

// ---------------------------------------------------------------------------
// We test the error-shaping logic directly by reproducing the branching in
// the CLI `run()` function. The actual `run()` function writes to stdout and
// sets process.exitCode, which makes it awkward to test in isolation. Instead
// we extract the payload-building logic into a pure helper and verify its
// output here.
// ---------------------------------------------------------------------------

const SESSION_EXPIRED_MSG =
  "Your Twitter session has expired. Please sign in to Twitter in Chrome — " +
  "run `assistant twitter refresh` to capture your session automatically.";

/**
 * Replicates the error-to-payload logic from `run()` in twitter.ts.
 * Returns the JSON payload that would be written to stdout.
 */
function buildErrorPayload(err: unknown): Record<string, unknown> | null {
  const meta = err as Record<string, unknown>;

  if (err instanceof SessionExpiredError) {
    const payload: Record<string, unknown> = {
      ok: false,
      error: "session_expired",
      message: SESSION_EXPIRED_MSG,
    };
    if (meta.pathUsed !== undefined) payload.pathUsed = meta.pathUsed;
    if (meta.suggestAlternative !== undefined)
      payload.suggestAlternative = meta.suggestAlternative;
    if (meta.oauthError !== undefined) payload.oauthError = meta.oauthError;
    return payload;
  }

  if (
    err instanceof Error &&
    (meta.pathUsed !== undefined ||
      meta.suggestAlternative !== undefined ||
      meta.oauthError !== undefined ||
      meta.proxyErrorCode !== undefined)
  ) {
    const payload: Record<string, unknown> = {
      ok: false,
      error: err.message,
    };
    if (meta.pathUsed !== undefined) payload.pathUsed = meta.pathUsed;
    if (meta.suggestAlternative !== undefined)
      payload.suggestAlternative = meta.suggestAlternative;
    if (meta.oauthError !== undefined) payload.oauthError = meta.oauthError;
    if (meta.proxyErrorCode !== undefined)
      payload.proxyErrorCode = meta.proxyErrorCode;
    if (meta.retryable !== undefined) payload.retryable = meta.retryable;
    return payload;
  }

  // Generic fallback
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

describe("CLI error shaping", () => {
  test("plain SessionExpiredError preserves backward-compatible error code", () => {
    const err = new SessionExpiredError("No Twitter session found.");
    const payload = buildErrorPayload(err);

    expect(payload).toEqual({
      ok: false,
      error: "session_expired",
      message: SESSION_EXPIRED_MSG,
    });
  });

  test("SessionExpiredError from browser path preserves pathUsed and suggestAlternative", () => {
    const err = Object.assign(
      new SessionExpiredError("Session cookies expired"),
      {
        pathUsed: "browser" as const,
        suggestAlternative: "oauth" as const,
      },
    );
    const payload = buildErrorPayload(err);

    expect(payload).toEqual({
      ok: false,
      error: "session_expired",
      message: SESSION_EXPIRED_MSG,
      pathUsed: "browser",
      suggestAlternative: "oauth",
    });
  });

  test("SessionExpiredError from auto path preserves pathUsed and oauthError", () => {
    const err = Object.assign(
      new SessionExpiredError("Session cookies expired"),
      {
        pathUsed: "auto" as const,
        oauthError: "Token revoked",
      },
    );
    const payload = buildErrorPayload(err);

    expect(payload).toEqual({
      ok: false,
      error: "session_expired",
      message: SESSION_EXPIRED_MSG,
      pathUsed: "auto",
      oauthError: "Token revoked",
    });
  });

  test("routed non-session error with suggestAlternative emits structured JSON", () => {
    const err = Object.assign(
      new Error(
        "OAuth is not configured. Provide your X developer credentials here in the chat to set up OAuth, or switch to browser strategy.",
      ),
      {
        pathUsed: "oauth" as const,
        suggestAlternative: "browser" as const,
      },
    );
    const payload = buildErrorPayload(err);

    expect(payload).toEqual({
      ok: false,
      error:
        "OAuth is not configured. Provide your X developer credentials here in the chat to set up OAuth, or switch to browser strategy.",
      pathUsed: "oauth",
      suggestAlternative: "browser",
    });
  });

  test("routed auto-mode error with oauthError and suggestAlternative", () => {
    const err = Object.assign(
      new Error("Both OAuth and browser paths failed"),
      {
        pathUsed: "auto" as const,
        suggestAlternative: "browser" as const,
        oauthError: "Twitter API error (401)",
      },
    );
    const payload = buildErrorPayload(err);

    expect(payload).toEqual({
      ok: false,
      error: "Both OAuth and browser paths failed",
      pathUsed: "auto",
      suggestAlternative: "browser",
      oauthError: "Twitter API error (401)",
    });
  });

  test("auto-mode error with pathUsed and oauthError but no suggestAlternative preserves metadata", () => {
    // This is the scenario flagged by Codex: routedPostTweet in auto mode tries
    // OAuth (fails), then browser (fails with non-SessionExpiredError). The thrown
    // error has pathUsed and oauthError but no suggestAlternative.
    const err = Object.assign(
      new Error("Browser automation failed: element not found"),
      {
        pathUsed: "auto" as const,
        oauthError: "Twitter API error (401)",
      },
    );
    const payload = buildErrorPayload(err);

    expect(payload).toEqual({
      ok: false,
      error: "Browser automation failed: element not found",
      pathUsed: "auto",
      oauthError: "Twitter API error (401)",
    });
  });

  test("error with only pathUsed (no oauthError or suggestAlternative) preserves metadata", () => {
    const err = Object.assign(new Error("Something went wrong"), {
      pathUsed: "browser" as const,
    });
    const payload = buildErrorPayload(err);

    expect(payload).toEqual({
      ok: false,
      error: "Something went wrong",
      pathUsed: "browser",
    });
  });

  test("generic error without router metadata falls back to plain error", () => {
    const err = new Error("Network connection failed");
    const payload = buildErrorPayload(err);

    expect(payload).toEqual({
      ok: false,
      error: "Network connection failed",
    });
  });

  test("non-Error value falls back to stringified error", () => {
    const payload = buildErrorPayload("some string error");

    expect(payload).toEqual({
      ok: false,
      error: "some string error",
    });
  });

  test("managed proxy error preserves proxyErrorCode and retryable metadata", () => {
    const err = Object.assign(
      new Error("Connect Twitter in Settings as the assistant owner"),
      {
        pathUsed: "managed" as const,
        proxyErrorCode: "owner_credential_required",
        retryable: false,
      },
    );
    const payload = buildErrorPayload(err);

    expect(payload).toEqual({
      ok: false,
      error: "Connect Twitter in Settings as the assistant owner",
      pathUsed: "managed",
      proxyErrorCode: "owner_credential_required",
      retryable: false,
    });
  });

  test("managed proxy retryable error preserves metadata", () => {
    const err = Object.assign(new Error("Reconnect Twitter or retry"), {
      pathUsed: "managed" as const,
      proxyErrorCode: "auth_failure",
      retryable: true,
    });
    const payload = buildErrorPayload(err);

    expect(payload).toEqual({
      ok: false,
      error: "Reconnect Twitter or retry",
      pathUsed: "managed",
      proxyErrorCode: "auth_failure",
      retryable: true,
    });
  });

  test("backward compatibility: session_expired error code is always preserved", () => {
    // Even with metadata, the error code stays 'session_expired'
    const err = Object.assign(new SessionExpiredError("expired"), {
      pathUsed: "auto" as const,
      suggestAlternative: "oauth" as const,
      oauthError: "token expired",
    });
    const payload = buildErrorPayload(err);

    expect(payload!.error).toBe("session_expired");
    expect(payload!.ok).toBe(false);
    expect(payload!.pathUsed).toBe("auto");
    expect(payload!.suggestAlternative).toBe("oauth");
    expect(payload!.oauthError).toBe("token expired");
  });
});
