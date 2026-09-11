import { afterEach, describe, expect, mock, test } from "bun:test";

const ttsSynthesizePost = mock(async () => ({
  data: null as Blob | null,
  error: undefined as unknown,
  response: { ok: false, status: 503 } as Pick<Response, "ok" | "status">,
}));

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  ttsSynthesizePost,
}));

const captureError = mock(() => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError,
}));

const { synthesizeMessagePlayback } = await import(
  "@/domains/chat/message-read-aloud-tts"
);

afterEach(() => {
  ttsSynthesizePost.mockClear();
  captureError.mockClear();
});

describe("synthesizeMessagePlayback", () => {
  test("returns audio when the daemon responds with a blob", async () => {
    const blob = new Blob(["audio"], { type: "audio/mpeg" });
    ttsSynthesizePost.mockImplementationOnce(async () => ({
      data: blob,
      error: undefined,
      response: { ok: true, status: 200 },
    }));

    const result = await synthesizeMessagePlayback({
      assistantId: "asst-1",
      text: "hello there",
      conversationId: "conv-xyz",
    });

    expect(result).toEqual({ kind: "audio", blob });
    expect(ttsSynthesizePost).toHaveBeenCalledTimes(1);
  });

  test("returns unavailable without reporting a 503", async () => {
    ttsSynthesizePost.mockImplementationOnce(async () => ({
      data: null,
      error: { detail: "TTS provider is not configured" },
      response: { ok: false, status: 503 },
    }));

    const result = await synthesizeMessagePlayback({
      assistantId: "asst-1",
      text: "hello there",
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(captureError).not.toHaveBeenCalled();
  });

  test("returns unavailable for a missing route on an older assistant", async () => {
    ttsSynthesizePost.mockImplementationOnce(async () => ({
      data: null,
      error: undefined,
      response: { ok: false, status: 404 },
    }));

    const result = await synthesizeMessagePlayback({
      assistantId: "asst-1",
      text: "hello there",
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(captureError).not.toHaveBeenCalled();
  });

  test("treats a JSON error body as unavailable", async () => {
    ttsSynthesizePost.mockImplementationOnce(async () => ({
      data: new Blob(['{"detail":"nope"}'], { type: "application/json" }),
      error: undefined,
      response: { ok: true, status: 200 },
    }));

    const result = await synthesizeMessagePlayback({
      assistantId: "asst-1",
      text: "hello there",
    });

    expect(result).toEqual({ kind: "unavailable" });
  });
});
