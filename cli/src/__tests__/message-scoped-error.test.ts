import { describe, expect, test } from "bun:test";

import { isMessageScopedError } from "../lib/message-scoped-error.js";

describe("isMessageScopedError", () => {
  test("an explicit message scope belongs to one message", () => {
    expect(
      isMessageScopedError({ scope: "message", clientMessageId: "n1" }),
    ).toBe(true);
  });

  test("an explicit turn scope ends the turn even with a nonce", () => {
    expect(isMessageScopedError({ scope: "turn", clientMessageId: "n1" })).toBe(
      false,
    );
  });

  test("a scopeless event with a nonce belongs to that message", () => {
    expect(isMessageScopedError({ clientMessageId: "n1" })).toBe(true);
  });

  test("a scopeless event without a nonce ends the turn", () => {
    expect(isMessageScopedError({})).toBe(false);
  });
});
