import { beforeEach, expect, mock, test } from "bun:test";

mock.module("@/generated/daemon/client.gen", () => ({
  client: { post: mock(async () => ({ response: { ok: true } })) },
}));
mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({ activeAssistantId: "assistant-1" }),
  },
}));

const { ScreenRecordingController } = await import("./screen-recording");

class FakeTrack {
  stopped = false;
  private ended: (() => void) | null = null;

  addEventListener(_type: string, listener: () => void): void {
    this.ended = listener;
  }

  stop(): void {
    this.stopped = true;
  }
}

class FakeRecorder {
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;

  start(): void {
    this.state = "recording";
  }

  pause(): void {
    this.state = "paused";
  }

  resume(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array([1, 2, 3])]),
    } as BlobEvent);
    this.onstop?.();
  }
}

const recordingId = "00000000-0000-4000-8000-000000000001";
const startEvent = {
  type: "recording_start" as const,
  recordingId,
  attachToConversationId: "conv-1",
};

beforeEach(() => {
  Object.assign(window, {
    vellum: {
      platform: "electron",
      screenRecording: {
        begin: mock(async () => undefined),
        append: mock(async () => undefined),
        finish: mock(async () => ({ filePath: "/recordings/capture.webm" })),
        abort: mock(async () => undefined),
        resolveSource: mock(async () => null),
      },
    },
  });
});

test("reports start, pause, resume, and completed attachment status", async () => {
  const statuses: Array<{ status: string; filePath?: string; error?: string }> =
    [];
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  let now = 1_000;
  const controller = new ScreenRecordingController({
    capture: async () => ({
      stream: {
        getTracks: () => [track],
        getVideoTracks: () => [track],
      } as unknown as MediaStream,
      close: () => track.stop(),
    }),
    chooseMimeType: () => "video/webm",
    createRecorder: () => recorder as unknown as MediaRecorder,
    now: () => now,
    reportStatus: async (_event, status, details) => {
      statuses.push({
        status,
        filePath: details?.filePath,
        error: details?.error,
      });
    },
  });

  await controller.handle(startEvent);
  await controller.handle({ type: "recording_pause", recordingId });
  await controller.handle({ type: "recording_resume", recordingId });
  now = 4_000;
  await controller.handle({ type: "recording_stop", recordingId });

  expect(statuses).toEqual([
    { status: "started", filePath: undefined, error: undefined },
    { status: "paused", filePath: undefined, error: undefined },
    { status: "resumed", filePath: undefined, error: undefined },
    {
      status: "stopped",
      filePath: "/recordings/capture.webm",
      error: undefined,
    },
  ]);
  expect(window.vellum!.screenRecording!.append).toHaveBeenCalledTimes(1);
  expect(track.stopped).toBeTrue();
});

test("reports restart cancellation when the source picker is denied", async () => {
  const statuses: string[] = [];
  const controller = new ScreenRecordingController({
    capture: async () => {
      throw new DOMException("Picker closed", "NotAllowedError");
    },
    chooseMimeType: () => "video/webm",
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    now: () => 0,
    reportStatus: async (_event, status) => {
      statuses.push(status);
    },
  });

  await controller.handle({ ...startEvent, operationToken: "restart-1" });

  expect(statuses).toEqual(["restart_cancelled"]);
  expect(window.vellum!.screenRecording!.begin).not.toHaveBeenCalled();
});
