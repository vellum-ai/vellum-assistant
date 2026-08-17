import { beforeEach, describe, expect, mock, test } from "bun:test";

const cancelPrefetchMock = mock((_conversationId: string) => {});

mock.module("../v3/voice-prefetch.js", () => ({
  cancelVoiceMemoryV3Prefetch: cancelPrefetchMock,
}));

const { default: voiceFrontDoorSettled } =
  await import("./voice-front-door-settled.js");

const baseContext = {
  conversationId: "conv-voice",
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
  broadcast: () => {},
};

describe("memory voice-front-door-settled hook", () => {
  beforeEach(() => {
    cancelPrefetchMock.mockClear();
  });

  test("keeps prepared memory for a successful escalation", async () => {
    await voiceFrontDoorSettled({ ...baseContext, outcome: "escalate" });

    expect(cancelPrefetchMock).not.toHaveBeenCalled();
  });

  test.each(["answer", "hold", "cancelled", "failed", "discarded"] as const)(
    "cancels prepared memory for %s",
    async (outcome) => {
      await voiceFrontDoorSettled({ ...baseContext, outcome });

      expect(cancelPrefetchMock).toHaveBeenCalledTimes(1);
      expect(cancelPrefetchMock).toHaveBeenCalledWith("conv-voice");
    },
  );
});
