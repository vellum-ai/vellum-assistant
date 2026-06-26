import { describe, expect, test } from "bun:test";

import { classifySlackError } from "./errors.js";

describe("classifySlackError", () => {
  test("classifies known error codes by category", () => {
    expect(classifySlackError("invalid_auth")).toBe("auth");
    expect(classifySlackError("rate_limited")).toBe("rate_limit");
    expect(classifySlackError("channel_not_found")).toBe("channel_not_found");
    expect(classifySlackError("missing_scope")).toBe("permission");
    expect(classifySlackError("user_not_found")).toBe("not_found");
  });

  test("classifies oversized Block Kit payload errors as client_error", () => {
    expect(classifySlackError("invalid_blocks")).toBe("client_error");
    expect(classifySlackError("msg_blocks_too_long")).toBe("client_error");
  });

  test("returns unknown for unrecognized codes and missing input", () => {
    expect(classifySlackError("some_new_error")).toBe("unknown");
    expect(classifySlackError(undefined)).toBe("unknown");
    expect(classifySlackError("")).toBe("unknown");
  });
});
