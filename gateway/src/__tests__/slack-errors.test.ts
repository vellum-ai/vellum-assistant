import { describe, test, expect } from "bun:test";
import { classifySlackError, isRetryable } from "../slack/errors.js";

describe("classifySlackError", () => {
  test("classifies auth errors", () => {
    expect(classifySlackError("invalid_auth")).toBe("auth");
    expect(classifySlackError("token_expired")).toBe("auth");
    expect(classifySlackError("token_revoked")).toBe("auth");
    expect(classifySlackError("not_authed")).toBe("auth");
    expect(classifySlackError("account_inactive")).toBe("auth");
    expect(classifySlackError("org_login_required")).toBe("auth");
  });

  test("classifies rate limit errors", () => {
    expect(classifySlackError("rate_limited")).toBe("rate_limit");
    expect(classifySlackError("ratelimited")).toBe("rate_limit");
  });

  test("classifies channel not found errors", () => {
    expect(classifySlackError("channel_not_found")).toBe("channel_not_found");
    expect(classifySlackError("is_archived")).toBe("channel_not_found");
  });

  test("classifies permission errors", () => {
    expect(classifySlackError("not_in_channel")).toBe("permission");
    expect(classifySlackError("missing_scope")).toBe("permission");
    expect(classifySlackError("ekm_access_denied")).toBe("permission");
    expect(classifySlackError("not_allowed_token_type")).toBe("permission");
    expect(classifySlackError("restricted_action")).toBe("permission");
    expect(classifySlackError("cannot_dm_bot")).toBe("permission");
  });

  test("classifies not found errors", () => {
    expect(classifySlackError("user_not_found")).toBe("not_found");
    expect(classifySlackError("message_not_found")).toBe("not_found");
    expect(classifySlackError("thread_not_found")).toBe("not_found");
  });

  test("returns unknown for unrecognized error codes", () => {
    expect(classifySlackError("some_new_error")).toBe("unknown");
    expect(classifySlackError("internal_error")).toBe("unknown");
  });

  test("returns unknown for undefined input", () => {
    expect(classifySlackError(undefined)).toBe("unknown");
  });

  test("returns unknown for empty string", () => {
    expect(classifySlackError("")).toBe("unknown");
  });
});

describe("isRetryable", () => {
  test("rate_limit is retryable", () => {
    expect(isRetryable("rate_limit")).toBe(true);
  });

  test("unknown is retryable", () => {
    expect(isRetryable("unknown")).toBe(true);
  });

  test("auth is not retryable", () => {
    expect(isRetryable("auth")).toBe(false);
  });

  test("not_found is not retryable", () => {
    expect(isRetryable("not_found")).toBe(false);
  });

  test("permission is not retryable", () => {
    expect(isRetryable("permission")).toBe(false);
  });

  test("channel_not_found is not retryable", () => {
    expect(isRetryable("channel_not_found")).toBe(false);
  });
});
