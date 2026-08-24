import { describe, expect, test } from "bun:test";

import { supportsKeyboardActivation } from "@/domains/chat/voice/keyboard-activation-host";

describe("supportsKeyboardActivation", () => {
  test("enables shortcuts for fine-pointer web surfaces", () => {
    expect(
      supportsKeyboardActivation({ electron: false, pointerCoarse: false }),
    ).toBe(true);
  });

  test("disables shortcuts for coarse-pointer web surfaces", () => {
    expect(
      supportsKeyboardActivation({ electron: false, pointerCoarse: true }),
    ).toBe(false);
  });

  test("keeps shortcuts enabled in Electron even when the pointer query is coarse", () => {
    expect(
      supportsKeyboardActivation({ electron: true, pointerCoarse: true }),
    ).toBe(true);
  });
});
