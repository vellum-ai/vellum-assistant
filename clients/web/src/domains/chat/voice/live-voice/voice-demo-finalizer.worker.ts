/// <reference lib="webworker" />

import {
  finalizeVoiceDemoCapture,
  type VoiceDemoFinalizerInput,
  type VoiceDemoFinalizerResult,
} from "@/domains/chat/voice/live-voice/voice-demo-finalizer";

self.onmessage = (event: MessageEvent<VoiceDemoFinalizerInput>) => {
  void finalizeVoiceDemoCapture(event.data)
    .then(({ filename, zip }) => {
      const result: VoiceDemoFinalizerResult = {
        ok: true,
        filename,
        zip,
      };
      self.postMessage(result, { transfer: [zip] });
    })
    .catch((error: unknown) => {
      const result: VoiceDemoFinalizerResult = {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "Voice demo finalization failed",
      };
      self.postMessage(result);
    });
};

export {};
