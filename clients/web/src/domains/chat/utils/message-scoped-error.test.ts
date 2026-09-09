import { describe, expect, test } from "bun:test";

import { isMessageScopedError } from "@/domains/chat/utils/message-scoped-error";

describe("isMessageScopedError", () => {
  test("treats an explicit message scope as the message's", () => {
    // GIVEN an error the daemon scoped to one message and did not name a nonce for
    const event = {
      type: "error",
      message: "Could not save your message.",
      scope: "message",
    } as const;

    // WHEN asking what the error belongs to
    const result = isMessageScopedError(event);

    // THEN the scope alone makes it the message's
    expect(result).toBe(true);
  });

  test("treats a nonce with no scope as the message's", () => {
    // GIVEN an error from a daemon that names the message but ships no scope field
    const event = {
      type: "error",
      message: "Could not save your message.",
      clientMessageId: "client-1",
    } as const;

    // WHEN asking what the error belongs to
    const result = isMessageScopedError(event);

    // THEN the nonce alone makes it the message's
    expect(result).toBe(true);
  });

  test("treats an explicit turn scope with no nonce as the turn's", () => {
    // GIVEN an error the daemon scoped to the turn
    const event = {
      type: "error",
      message: "Something went wrong.",
      scope: "turn",
    } as const;

    // WHEN asking what the error belongs to
    const result = isMessageScopedError(event);

    // THEN it is the turn's terminal error
    expect(result).toBe(false);
  });

  test("treats an error with neither scope nor nonce as the turn's", () => {
    // GIVEN a bare error carrying no scope and no nonce
    const event = {
      type: "error",
      message: "Something went wrong.",
    } as const;

    // WHEN asking what the error belongs to
    const result = isMessageScopedError(event);

    // THEN the absent scope reads as the turn's terminal error
    expect(result).toBe(false);
  });

  test("treats a turn scope carrying a nonce as the turn's", () => {
    // GIVEN an error labelled with the turn scope that also names a message
    const event = {
      type: "error",
      message: "Could not save your message.",
      scope: "turn",
      clientMessageId: "client-1",
    } as const;

    // WHEN asking what the error belongs to
    const result = isMessageScopedError(event);

    // THEN the explicit scope decides, and the nonce is not read as a fallback
    expect(result).toBe(false);
  });
});
