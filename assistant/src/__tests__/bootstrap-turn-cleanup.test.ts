import { describe, expect, test } from "bun:test";

import {
  BOOTSTRAP_CLEANUP_USER_TURN_THRESHOLD,
  countBootstrapUserTurns,
  shouldCleanupBootstrapAfterTurn,
} from "../daemon/bootstrap-turn-cleanup.js";

function message(role: string, content: string) {
  return { role, content };
}

describe("bootstrap turn cleanup", () => {
  test("does not count the hidden wake-up greeting as a user turn", () => {
    const messages = [
      message(
        "user",
        JSON.stringify([{ type: "text", text: "Wake up, my friend." }]),
      ),
      message("assistant", "hello"),
      message("user", "real request"),
    ];

    expect(countBootstrapUserTurns(messages)).toBe(1);
  });

  test("cleans up after the configured user-turn threshold", () => {
    const messages = Array.from(
      { length: BOOTSTRAP_CLEANUP_USER_TURN_THRESHOLD },
      (_value, index) => message("user", `request ${index + 1}`),
    );

    expect(shouldCleanupBootstrapAfterTurn(messages)).toBe(true);
  });

  test("keeps bootstrap before the configured user-turn threshold", () => {
    const messages = Array.from(
      { length: BOOTSTRAP_CLEANUP_USER_TURN_THRESHOLD - 1 },
      (_value, index) => message("user", `request ${index + 1}`),
    );

    expect(shouldCleanupBootstrapAfterTurn(messages)).toBe(false);
  });
});
