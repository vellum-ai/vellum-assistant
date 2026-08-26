import { beforeEach, expect, mock, test } from "bun:test";

mock.module("@/generated/daemon/client.gen", () => ({
  client: { post: mock(async () => ({ response: { ok: true } })) },
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

  end(): void {
    this.ended?.();
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

test("reports the full lifecycle to the initiating assistant", async () => {
  const statuses: Array<{
    assistantId: string;
    status: string;
    filePath?: string;
    error?: string;
  }> = [];
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
    ownsLifecycle: () => true,
    now: () => now,
    reportStatus: async (assistantId, _event, status, details) => {
      statuses.push({
        assistantId,
        status,
        filePath: details?.filePath,
        error: details?.error,
      });
    },
  });

  await controller.handle(startEvent, "assistant-1");
  await controller.handle(
    { type: "recording_pause", recordingId },
    "assistant-2",
  );
  await controller.handle(
    { type: "recording_resume", recordingId },
    "assistant-2",
  );
  now = 4_000;
  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-2",
  );

  expect(statuses).toEqual([
    {
      assistantId: "assistant-1",
      status: "started",
      filePath: undefined,
      error: undefined,
    },
    {
      assistantId: "assistant-1",
      status: "paused",
      filePath: undefined,
      error: undefined,
    },
    {
      assistantId: "assistant-1",
      status: "resumed",
      filePath: undefined,
      error: undefined,
    },
    {
      assistantId: "assistant-1",
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
    ownsLifecycle: () => true,
    now: () => 0,
    reportStatus: async (_assistantId, _event, status) => {
      statuses.push(status);
    },
  });

  await controller.handle(
    { ...startEvent, operationToken: "restart-1" },
    "assistant-1",
  );

  expect(statuses).toEqual(["restart_cancelled"]);
  expect(window.vellum!.screenRecording!.begin).not.toHaveBeenCalled();
});

test("ignores lifecycle events in a popout renderer", async () => {
  const capture = mock(async () => {
    throw new Error("should not capture");
  });
  const reportStatus = mock(async () => undefined);
  const controller = new ScreenRecordingController({
    capture,
    chooseMimeType: () => "video/webm",
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    ownsLifecycle: () => false,
    now: () => 0,
    reportStatus,
  });

  await controller.handle(startEvent, "assistant-1");

  expect(capture).not.toHaveBeenCalled();
  expect(reportStatus).not.toHaveBeenCalled();
});

test("handles a failed share-bar auto-stop without an unhandled rejection", async () => {
  const statuses: string[] = [];
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  window.vellum!.screenRecording!.finish = mock(async () => {
    throw new Error("write failed");
  });
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
    ownsLifecycle: () => true,
    now: () => 0,
    reportStatus: async (_assistantId, _event, status) => {
      statuses.push(status);
    },
  });

  await controller.handle(startEvent, "assistant-1");
  track.end();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(statuses).toEqual(["started", "failed"]);
  expect(window.vellum!.screenRecording!.abort).toHaveBeenCalledWith(
    recordingId,
  );
});

test("honors stop while source selection is pending", async () => {
  const statuses: string[] = [];
  const track = new FakeTrack();
  let resolveCapture!: (capture: {
    stream: MediaStream;
    close: () => void;
  }) => void;
  const capture = mock(
    () =>
      new Promise<{ stream: MediaStream; close: () => void }>((resolve) => {
        resolveCapture = resolve;
      }),
  );
  const recorder = new FakeRecorder();
  const controller = new ScreenRecordingController({
    capture,
    chooseMimeType: () => "video/webm",
    createRecorder: () => recorder as unknown as MediaRecorder,
    ownsLifecycle: () => true,
    now: () => 0,
    reportStatus: async (_assistantId, _event, status) => {
      statuses.push(status);
    },
  });

  const start = controller.handle(startEvent, "assistant-1");
  await Promise.resolve();
  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-1",
  );
  resolveCapture({
    stream: {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
    close: () => track.stop(),
  });
  await start;

  expect(statuses).toEqual(["stopped"]);
  expect(track.stopped).toBeTrue();
  expect(recorder.state).toBe("inactive");
  expect(window.vellum!.screenRecording!.begin).not.toHaveBeenCalled();
});
