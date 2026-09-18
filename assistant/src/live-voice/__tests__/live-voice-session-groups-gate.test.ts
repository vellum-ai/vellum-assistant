import { afterEach, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { setModeSessionRecoveryHealthy } from "../../config/session-groups-gate.js";
import {
  getLiveVoiceSessionManager,
  setBundledLiveVoiceSessionFactory,
  setLiveVoiceSessionManagerForTesting,
} from "../live-voice-manager.js";
import type { LiveVoiceSessionOptions } from "../live-voice-session.js";
import type {
  LiveVoiceSession,
  LiveVoiceSessionFactoryContext,
} from "../live-voice-session-manager.js";
import type { LiveVoiceClientStartFrame } from "../protocol.js";

const START_FRAME: LiveVoiceClientStartFrame = {
  type: "start",
  conversationId: "conversation-123",
  audio: { mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
};

function fakeSession(): LiveVoiceSession {
  return {
    start: mock(() => {}),
    handleClientFrame: mock(() => {}),
    handleBinaryAudio: mock(() => {}),
    close: mock(() => {}),
  };
}

async function captureProductionOptions(
  enabled: boolean,
): Promise<LiveVoiceSessionOptions> {
  setOverridesForTesting({ "session-groups": enabled });
  let captured: LiveVoiceSessionOptions | undefined;
  setBundledLiveVoiceSessionFactory(
    (
      _context: LiveVoiceSessionFactoryContext,
      options: LiveVoiceSessionOptions = {},
    ) => {
      captured = options;
      return fakeSession() as never;
    },
  );
  setLiveVoiceSessionManagerForTesting(null);

  const manager = getLiveVoiceSessionManager();
  const result = await manager.startSession(START_FRAME, {
    sendFrame: mock(() => {}),
  });
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") {
    throw new Error("expected live voice session to be accepted");
  }
  await manager.releaseSession(result.sessionId, "client_end");
  return captured ?? {};
}

afterEach(() => {
  setModeSessionRecoveryHealthy(true);
  setOverridesForTesting({});
  setBundledLiveVoiceSessionFactory(null);
  setLiveVoiceSessionManagerForTesting(null);
});

describe("live voice session-groups gate", () => {
  test.each([false, true])(
    "omits camera tracking after failed recovery with flag %s",
    async (enabled) => {
      setModeSessionRecoveryHealthy(false);
      const options = await captureProductionOptions(enabled);
      expect(options.acquireModeSessionResidency).toBeUndefined();
    },
  );
  test("constructs a normal session without camera tracking while disabled", async () => {
    const options = await captureProductionOptions(false);

    expect(options.acquireModeSessionResidency).toBeUndefined();
  });

  test("injects camera tracking for an enabled assistant session", async () => {
    const options = await captureProductionOptions(true);

    expect(options.acquireModeSessionResidency).toBeFunction();
  });
});
