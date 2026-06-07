import { describe, expect, test } from "bun:test";

import { shouldEnablePushToTalk } from "@/domains/chat/voice/push-to-talk-host";

describe("shouldEnablePushToTalk", () => {
  test("enables PTT for fine-pointer web surfaces", () => {
    expect(
      shouldEnablePushToTalk({ electron: false, pointerCoarse: false }),
    ).toBe(true);
  });

  test("disables PTT for coarse-pointer web surfaces", () => {
    expect(
      shouldEnablePushToTalk({ electron: false, pointerCoarse: true }),
    ).toBe(false);
  });

  test("keeps PTT enabled in Electron even when the pointer query is coarse", () => {
    expect(
      shouldEnablePushToTalk({ electron: true, pointerCoarse: true }),
    ).toBe(true);
  });
});
