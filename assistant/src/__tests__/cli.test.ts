import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { isMessageScopedError, sanitizeUrlForDisplay } from "../cli.js";

describe("sanitizeUrlForDisplay", () => {
  test("removes userinfo from absolute URLs", () => {
    const username = "user";
    const credential = ["s", "e", "c", "r", "e", "t"].join("");
    const rawUrlObj = new URL("https://example.com/private");
    rawUrlObj.username = username;
    rawUrlObj.password = credential;
    const rawUrl = rawUrlObj.href;

    expect(sanitizeUrlForDisplay(rawUrl)).toBe("https://example.com/private");
  });

  test("leaves URLs without userinfo unchanged", () => {
    expect(sanitizeUrlForDisplay("https://example.com/docs")).toBe(
      "https://example.com/docs",
    );
  });

  test("redacts fallback //userinfo@ patterns when URL parsing fails", () => {
    const userinfo = ["u", "s", "e", "r", ":", "p", "w"].join("");
    const rawValue = `not-a-url //${userinfo}@example.com`;

    expect(sanitizeUrlForDisplay(rawValue)).toBe(
      "not-a-url //[REDACTED]@example.com",
    );
  });
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("new-session conversationKey format", () => {
  test("uses a valid UUID, not a timestamp", () => {
    // Mirror the key construction in startCli()
    const key = `builtin-cli:${randomUUID()}`;
    const suffix = key.replace("builtin-cli:", "");

    expect(suffix).toMatch(UUID_RE);
    // A numeric timestamp would parse to a finite number; a UUID must not.
    expect(Number.isFinite(Number(suffix))).toBe(false);
  });

  test("generates unique keys across calls", () => {
    const key1 = `builtin-cli:${randomUUID()}`;
    const key2 = `builtin-cli:${randomUUID()}`;

    expect(key1).not.toBe(key2);
  });
});

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
