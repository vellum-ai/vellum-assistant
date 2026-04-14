import { describe, test, expect } from "bun:test";
import {
  classifySlackError,
  isRetryable,
  getUserMessage,
} from "../slack/errors.js";

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

  test("classifies invalid_blocks as client_error", () => {
    expect(classifySlackError("invalid_blocks")).toBe("client_error");
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

  test("client_error is not retryable", () => {
    expect(isRetryable("client_error")).toBe(false);
  });
});

describe("getUserMessage", () => {
  test("returns specific message for channel_not_found", () => {
    expect(getUserMessage("channel_not_found")).toBe(
      "I can't send messages to this channel. Please re-add me to the channel.",
    );
  });

  test("returns specific message for not_in_channel", () => {
    expect(getUserMessage("not_in_channel")).toBe(
      "I need to be invited to this channel first. Please add me to the channel.",
    );
  });

  test("returns specific message for missing_scope", () => {
    expect(getUserMessage("missing_scope")).toBe(
      "I don't have the required permissions. Please re-install the Slack app with the necessary scopes.",
    );
  });

  test("returns specific message for token_revoked", () => {
    expect(getUserMessage("token_revoked")).toBe(
      "My Slack connection has expired. Please re-configure the Slack integration.",
    );
  });

  test("returns specific message for token_expired", () => {
    expect(getUserMessage("token_expired")).toBe(
      "My Slack connection has expired. Please re-configure the Slack integration.",
    );
  });

  test("returns specific message for invalid_auth", () => {
    expect(getUserMessage("invalid_auth")).toBe(
      "My Slack connection has expired. Please re-configure the Slack integration.",
    );
  });

  test("returns specific message for is_archived", () => {
    expect(getUserMessage("is_archived")).toBe(
      "This channel has been archived. Please unarchive it or use a different channel.",
    );
  });

  test("returns specific message for cannot_dm_bot", () => {
    expect(getUserMessage("cannot_dm_bot")).toBe(
      "I can't send direct messages to other bots.",
    );
  });

  test("falls back to category message for auth errors without specific override", () => {
    expect(getUserMessage("not_authed")).toBe(
      "My Slack connection has expired. Please re-configure the Slack integration.",
    );
    expect(getUserMessage("account_inactive")).toBe(
      "My Slack connection has expired. Please re-configure the Slack integration.",
    );
  });

  test("falls back to category message for permission errors without specific override", () => {
    expect(getUserMessage("ekm_access_denied")).toBe(
      "I don't have the required permissions for this channel. Please check my access.",
    );
    expect(getUserMessage("restricted_action")).toBe(
      "I don't have the required permissions for this channel. Please check my access.",
    );
  });

  test("returns undefined for unknown errors", () => {
    expect(getUserMessage("some_new_error")).toBeUndefined();
    expect(getUserMessage(undefined)).toBeUndefined();
    expect(getUserMessage("")).toBeUndefined();
  });

  test("returns message for rate_limit errors", () => {
    expect(getUserMessage("rate_limited")).toBe(
      "Slack rate limit reached. Please try again in a moment.",
    );
  });

  test("returns message for invalid_blocks client_error", () => {
    expect(getUserMessage("invalid_blocks")).toBe(
      "I couldn't format that message for Slack. Please try again.",
    );
  });
});
