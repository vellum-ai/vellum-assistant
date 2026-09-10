import { describe, expect, test } from "bun:test";

import { isMessageScopedError } from "../message-scoped-error.js";

describe("isMessageScopedError", () => {
  test("an explicit message scope is the message's", () => {
    expect(
      isMessageScopedError({ scope: "message", clientMessageId: "n1" }),
    ).toBe(true);
  });

  test("an explicit turn scope is the turn's, whatever nonce it names", () => {
    expect(isMessageScopedError({ scope: "turn", clientMessageId: "n1" })).toBe(
      false,
    );
  });

  test("a nonce with no scope is the message's", () => {
    expect(isMessageScopedError({ clientMessageId: "n1" })).toBe(true);
  });

  test("neither scope nor nonce is the turn's", () => {
    expect(isMessageScopedError({})).toBe(false);
  });
});
