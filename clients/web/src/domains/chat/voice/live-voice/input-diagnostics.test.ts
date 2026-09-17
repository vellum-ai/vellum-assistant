import { expect, spyOn, test } from "bun:test";

import { recordVoiceInputDiagnostic } from "@/domains/chat/voice/live-voice/input-diagnostics";
import { getLifecycleDiagnosticsEvents } from "@/lib/diagnostics";

test("voice input events survive both web export and Electron console serialization", () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    const details = {
      captureId: "capture-123",
      sessionId: "session-123",
      playbackResumed: false,
    };
    recordVoiceInputDiagnostic("utterance_discarded", details);
    expect(getLifecycleDiagnosticsEvents().at(-1)).toMatchObject({
      kind: "voice_input",
      details: { event: "utterance_discarded", ...details },
    });
    expect(info).toHaveBeenCalledWith(
      `[live-voice-input] ${JSON.stringify({ event: "utterance_discarded", ...details })}`,
    );
  } finally {
    info.mockRestore();
  }
});
