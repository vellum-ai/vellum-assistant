import { describe, expect, test } from "bun:test";

import { requestNativeTranscription } from "@/runtime/native-dictation-transcription";

describe("requestNativeTranscription", () => {
  test("retains a transcript emitted before the request is acknowledged", async () => {
    let listener: ((event: { text: string }) => void) | undefined;
    let unsubscribed = false;
    const bridge = {
      onTranscribed(callback: (event: { text: string }) => void) {
        listener = callback;
        return () => {
          unsubscribed = true;
        };
      },
      async transcribe() {
        listener?.({ text: "fast transcript" });
        return { ok: true };
      },
    };

    await expect(
      requestNativeTranscription(bridge, new ArrayBuffer(2), 1000),
    ).resolves.toEqual({ ok: true, text: "fast transcript" });
    expect(unsubscribed).toBe(true);
  });
});
