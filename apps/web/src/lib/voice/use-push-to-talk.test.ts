import { describe, expect, test } from "bun:test";

import { PTT_HOLD_DELAY_MS } from "@/lib/voice/use-push-to-talk.js";

describe("PTT_HOLD_DELAY_MS", () => {
  test("is 300ms matching macOS PTTActivator hold delay", () => {
    expect(PTT_HOLD_DELAY_MS).toBe(300);
  });
});
