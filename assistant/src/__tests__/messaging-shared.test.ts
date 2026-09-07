import { describe, expect, test } from "bun:test";

import { isMailboxAddress } from "../config/bundled-skills/messaging/tools/shared.js";

describe("isMailboxAddress", () => {
  test("accepts a bare email", () => {
    expect(isMailboxAddress("user@example.com")).toBe(true);
  });

  test("accepts a display-name address", () => {
    expect(isMailboxAddress("Alice <alice@example.org>")).toBe(true);
  });

  test("rejects placeholders used when the recipient is unknown", () => {
    expect(isMailboxAddress("drafts")).toBe(false);
    expect(isMailboxAddress("outlook")).toBe(false);
    expect(isMailboxAddress("")).toBe(false);
  });
});
