import { beforeEach, expect, mock, test } from "bun:test";
import {
  MIN_VERSION as RECORDING_OWNERSHIP_MIN_VERSION,
  supportsRecordingOwnership,
} from "@/lib/backwards-compat/recording-ownership";
import { whenAssistantVersionKnownFor } from "@/lib/backwards-compat/utils";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const clientPost = mock(async () => ({
  data: { ok: true } as unknown,
  response: { ok: true, status: 200 },
}));
mock.module("@/generated/daemon/client.gen", () => ({
  client: { post: clientPost },
}));

const {
  ScreenRecordingController,
  RecordingRequestError,
  captureSelectedSource,
  postStatus,
  requiresRecordingTransfer,
  transferRecording,
} = await import("./screen-recording");

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

const localTransferDependencies = {
  claimRecording: async () => "claimed" as const,
  maintainClaim: () => () => undefined,
  requiresTransfer: () => false,
  supportsOwnership: () => true,
  transferRecording: async () => ({}),
  waitForAssistantVersion: async () => undefined,
  waitBeforeRetry: async () => undefined,
};

beforeEach(() => {
  clientPost.mockClear();
  useAssistantIdentityStore.getState().clearIdentity();
  Object.assign(window, {
    __VELLUM_CONFIG__: { deviceId: "desktop-client-1" },
    vellum: {
      platform: "electron",
      screenRecording: {
        begin: mock(async () => undefined),
        append: mock(async () => undefined),
        finish: mock(async () => ({ filePath: "/recordings/capture.webm" })),
        abort: mock(async () => undefined),
        read: mock(async () => ({ data: new Uint8Array(), eof: true })),
        release: mock(async () => undefined),
        resolveSource: mock(async () => null),
      },
    },
  });
});

test("reports status with the Electron main-process client identity", async () => {
  await postStatus("assistant-1", startEvent, "stopped", {
    filePath: "/recordings/capture.webm",
  });

  expect(clientPost).toHaveBeenCalledWith(
    expect.objectContaining({
      headers: { "Vellum-Device-Id": "desktop-client-1" },
    }),
  );
});

const createVersionGatedController = () => {
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const claimRecordingMock = mock(async () => "claimed" as const);
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    claimRecording: claimRecordingMock,
    reportStatus: async () => undefined,
    supportsOwnership: supportsRecordingOwnership,
    waitForAssistantVersion: whenAssistantVersionKnownFor,
  });
  return { claimRecordingMock, controller, recorder };
};

test("encodes each remote transfer chunk in its own request", async () => {
  await transferRecording(
    "assistant-remote",
    recordingId,
    "append",
    new Uint8Array([1, 2, 3]),
    7,
  );

  expect(clientPost).toHaveBeenCalledWith(
    expect.objectContaining({
      body: {
        recordingId,
        operation: "append",
        data: "AQID",
        sequence: 7,
      },
    }),
  );
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
    ...localTransferDependencies,
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

test("finalizes the source recording when the selected assistant changes", async () => {
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const statuses: Array<{ assistantId: string; status: string }> = [];
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    reportStatus: async (assistantId, _event, status) => {
      statuses.push({ assistantId, status });
    },
  });

  await controller.handle(startEvent, "assistant-a");
  await controller.handleAssistantChange("assistant-b");

  expect(statuses).toEqual([
    { assistantId: "assistant-a", status: "started" },
    { assistantId: "assistant-a", status: "stopped" },
  ]);
  expect(recorder.state).toBe("inactive");
  expect(track.stopped).toBeTrue();
  expect(window.vellum!.screenRecording!.finish).toHaveBeenCalledTimes(1);
});

test("finalizes active capture when the selected assistant is cleared", async () => {
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const statuses: string[] = [];
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
  await controller.handleAssistantChange(null);

  expect(statuses).toEqual(["started", "stopped"]);
  expect(recorder.state).toBe("inactive");
  expect(track.stopped).toBeTrue();
});

test("finalizes active capture when the lifecycle owner unmounts", async () => {
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const statuses: string[] = [];
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
  await controller.handleLifecycleOwnerUnmount();

  expect(statuses).toEqual(["started", "stopped"]);
  expect(recorder.state).toBe("inactive");
  expect(track.stopped).toBeTrue();
  expect(window.vellum!.screenRecording!.finish).toHaveBeenCalledTimes(1);
});

test("reports restart cancellation when the source picker is denied", async () => {
  const statuses: string[] = [];
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    ...localTransferDependencies,
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
    ...localTransferDependencies,
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
    ...localTransferDependencies,
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
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  expect(statuses).toEqual(["restart_cancelled"]);
  expect(track.stopped).toBeTrue();
  expect(recorder.state).toBe("inactive");
  expect(window.vellum!.screenRecording!.begin).not.toHaveBeenCalled();
});

test("cancels a dismissed picker after stop without finalizing", async () => {
  const statuses: string[] = [];
  let rejectCapture!: (error: unknown) => void;
  const capture = mock(
    () =>
      new Promise<never>((_resolve, reject) => {
        rejectCapture = reject;
      }),
  );
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
    capture,
    chooseMimeType: () => "video/webm",
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    ownsLifecycle: () => true,
    now: () => 0,
    reportStatus: async (_assistantId, _event, status) => {
      statuses.push(status);
    },
  });

  const start = controller.handle(startEvent, "assistant-1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-1",
  );
  rejectCapture(new DOMException("dismissed", "NotAllowedError"));
  await start;

  expect(statuses).toEqual(["restart_cancelled"]);
  expect(window.vellum!.screenRecording!.begin).not.toHaveBeenCalled();
});

test("releases the prior recorder before a synchronous restart start", async () => {
  const statuses: Array<{ recordingId: string; status: string }> = [];
  const recorders = [new FakeRecorder(), new FakeRecorder()];
  const tracks = [new FakeTrack(), new FakeTrack()];
  let captureIndex = 0;
  let recorderIndex = 0;
  const replacementId = "00000000-0000-4000-8000-000000000002";
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
    capture: async () => {
      const track = tracks[captureIndex++];
      return {
        stream: {
          getTracks: () => [track],
          getVideoTracks: () => [track],
        } as unknown as MediaStream,
        close: () => track.stop(),
      };
    },
    chooseMimeType: () => "video/webm",
    createRecorder: () =>
      recorders[recorderIndex++] as unknown as MediaRecorder,
    ownsLifecycle: () => true,
    now: () => 0,
    reportStatus: async (assistantId, event, status) => {
      statuses.push({ recordingId: event.recordingId, status });
      if (event.recordingId === recordingId && status === "stopped") {
        await controller.handle(
          {
            ...startEvent,
            recordingId: replacementId,
            operationToken: "restart-1",
          },
          assistantId,
        );
      }
    },
  });

  await controller.handle(startEvent, "assistant-1");
  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-1",
  );

  expect(statuses).toEqual([
    { recordingId, status: "started" },
    { recordingId, status: "stopped" },
    { recordingId: replacementId, status: "started" },
  ]);
  expect(tracks[0].stopped).toBeTrue();
  expect(recorders[1].state).toBe("recording");
});

test("queues and coalesces another assistant's start until release", async () => {
  const replacementId = "00000000-0000-4000-8000-000000000002";
  const recorders = [new FakeRecorder(), new FakeRecorder()];
  const tracks = [new FakeTrack(), new FakeTrack()];
  const capturedIds: string[] = [];
  const statuses: Array<{
    assistantId: string;
    recordingId: string;
    status: string;
  }> = [];
  let recorderIndex = 0;
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
    capture: async (event) => {
      capturedIds.push(event.recordingId);
      const track = tracks[capturedIds.length - 1];
      return {
        stream: {
          getTracks: () => [track],
          getVideoTracks: () => [track],
        } as unknown as MediaStream,
        close: () => track.stop(),
      };
    },
    chooseMimeType: () => "video/webm",
    createRecorder: () =>
      recorders[recorderIndex++] as unknown as MediaRecorder,
    ownsLifecycle: () => true,
    now: () => 0,
    reportStatus: async (assistantId, event, status) => {
      statuses.push({ assistantId, recordingId: event.recordingId, status });
    },
  });

  await controller.handle(startEvent, "assistant-a");
  const queued = controller.handle(
    { ...startEvent, recordingId: replacementId },
    "assistant-b",
  );
  const duplicate = controller.handle(
    { ...startEvent, recordingId: replacementId },
    "assistant-b",
  );
  await Promise.resolve();

  expect(capturedIds).toEqual([recordingId]);

  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-a",
  );
  await Promise.all([queued, duplicate]);

  expect(capturedIds).toEqual([recordingId, replacementId]);
  expect(
    statuses.filter(
      (entry) =>
        entry.assistantId === "assistant-b" && entry.status === "started",
    ),
  ).toEqual([
    {
      assistantId: "assistant-b",
      recordingId: replacementId,
      status: "started",
    },
  ]);
  expect(recorders[1].state).toBe("recording");
});

test("cancels a queued start without interrupting the active assistant", async () => {
  const queuedId = "00000000-0000-4000-8000-000000000002";
  const capture = mock(async () => {
    const track = new FakeTrack();
    return {
      stream: {
        getTracks: () => [track],
        getVideoTracks: () => [track],
      } as unknown as MediaStream,
      close: () => track.stop(),
    };
  });
  const recorder = new FakeRecorder();
  const statuses: Array<{
    assistantId: string;
    recordingId: string;
    status: string;
  }> = [];
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
    capture,
    chooseMimeType: () => "video/webm",
    createRecorder: () => recorder as unknown as MediaRecorder,
    ownsLifecycle: () => true,
    now: () => 0,
    reportStatus: async (assistantId, event, status) => {
      statuses.push({ assistantId, recordingId: event.recordingId, status });
    },
  });

  await controller.handle(startEvent, "assistant-a");
  const queued = controller.handle(
    { ...startEvent, recordingId: queuedId },
    "assistant-b",
  );
  await controller.handle(
    { type: "recording_stop", recordingId: queuedId },
    "assistant-b",
  );
  await queued;

  expect(capture).toHaveBeenCalledTimes(1);
  expect(recorder.state).toBe("recording");
  expect(statuses).toContainEqual({
    assistantId: "assistant-b",
    recordingId: queuedId,
    status: "restart_cancelled",
  });
});

test("streams remote recording chunks before reporting stopped", async () => {
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const transfers: Array<{
    assistantId: string;
    operation: string;
    chunk?: number[];
    sequence?: number;
  }> = [];
  let appendAttempts = 0;
  const stoppedDetails: Array<{
    attachmentId?: string;
    filePath?: string;
    durationMs?: number;
  }> = [];
  window.vellum!.screenRecording!.finish = mock(async () => ({
    filePath: "/recordings/capture.webm",
  }));
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
    claimRecording: async () => "claimed" as const,
    maintainClaim: () => () => undefined,
    reportStatus: async (_assistantId, _event, status, details) => {
      if (status === "stopped") {
        stoppedDetails.push(details ?? {});
      }
    },
    requiresTransfer: () => true,
    supportsOwnership: () => true,
    transferRecording: async (
      assistantId,
      _recordingId,
      operation,
      chunk,
      sequence,
    ) => {
      transfers.push({
        assistantId,
        operation,
        ...(chunk ? { chunk: [...chunk] } : {}),
        ...(sequence !== undefined ? { sequence } : {}),
      });
      if (operation === "append" && appendAttempts++ === 0) {
        throw new Error("temporary tunnel interruption");
      }
      return operation === "finish"
        ? { attachmentId: "attachment-remote" }
        : {};
    },
    waitForAssistantVersion: async () => undefined,
    waitBeforeRetry: async () => undefined,
  });

  await controller.handle(startEvent, "assistant-remote");
  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-remote",
  );

  expect(transfers).toEqual([
    { assistantId: "assistant-remote", operation: "begin" },
    {
      assistantId: "assistant-remote",
      operation: "append",
      chunk: [1, 2, 3],
      sequence: 0,
    },
    {
      assistantId: "assistant-remote",
      operation: "append",
      chunk: [1, 2, 3],
      sequence: 0,
    },
    { assistantId: "assistant-remote", operation: "finish" },
  ]);
  expect(stoppedDetails).toEqual([
    { attachmentId: "attachment-remote", durationMs: 0 },
  ]);
});

test("retries an idempotent stopped status after a lost response", async () => {
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const statuses: string[] = [];
  let stoppedAttempts = 0;
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
      if (status === "stopped" && stoppedAttempts++ === 0) {
        throw new Error("response lost after processing");
      }
    },
  });

  await controller.handle(startEvent, "assistant-1");
  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-1",
  );

  expect(statuses).toEqual(["started", "stopped", "stopped"]);
  expect(track.stopped).toBeTrue();
});

test("retries an idempotent started status after a lost response", async () => {
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const statuses: string[] = [];
  let startedAttempts = 0;
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
      if (status === "started" && startedAttempts++ === 0) {
        throw new Error("response lost after processing");
      }
    },
  });

  await controller.handle(startEvent, "assistant-1");

  expect(statuses).toEqual(["started", "started"]);
  expect(recorder.state).toBe("recording");
  expect(track.stopped).toBeFalse();
});

test("retries an idempotent transfer begin after a lost response", async () => {
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const operations: string[] = [];
  let beginAttempts = 0;
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    reportStatus: async () => undefined,
    requiresTransfer: () => true,
    transferRecording: async (_assistantId, _recordingId, operation) => {
      operations.push(operation);
      if (operation === "begin" && beginAttempts++ === 0) {
        throw new Error("response lost after processing");
      }
      return {};
    },
  });

  await controller.handle(startEvent, "assistant-remote");

  expect(operations).toEqual(["begin", "begin"]);
  expect(window.vellum!.screenRecording!.begin).toHaveBeenCalledTimes(1);
  expect(recorder.state).toBe("recording");
  expect(track.stopped).toBeFalse();
});

test("only the client that wins the claim starts capture", async () => {
  const election: { owner: string | null } = { owner: null };
  const capture = mock(async () => {
    const track = new FakeTrack();
    return {
      stream: {
        getTracks: () => [track],
        getVideoTracks: () => [track],
      } as unknown as MediaStream,
      close: () => track.stop(),
    };
  });
  const dependencies = {
    ...localTransferDependencies,
    capture,
    chooseMimeType: () => "video/webm",
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    ownsLifecycle: () => true,
    now: () => 0,
    reportStatus: async () => undefined,
  };
  const claimAs = (clientId: string) => async () => {
    if (!election.owner) {
      election.owner = clientId;
    }
    return election.owner === clientId ? "claimed" : "occupied";
  };
  const first = new ScreenRecordingController({
    ...dependencies,
    claimRecording: claimAs("client-1"),
  });
  let continueRetry!: () => void;
  let markRetryWaiting!: () => void;
  const retryWaiting = new Promise<void>((resolve) => {
    markRetryWaiting = resolve;
  });
  const second = new ScreenRecordingController({
    ...dependencies,
    claimRecording: claimAs("client-2"),
    waitBeforeRetry: () => {
      markRetryWaiting();
      return new Promise<void>((resolve) => {
        continueRetry = resolve;
      });
    },
  });

  const firstStart = first.handle(startEvent, "assistant-1");
  const secondStart = second.handle(startEvent, "assistant-1");
  await Promise.all([firstStart, retryWaiting]);
  await second.handle({ type: "recording_stop", recordingId }, "assistant-1");
  continueRetry();
  await secondStart;

  expect(capture).toHaveBeenCalledTimes(1);
  expect(election.owner).toBe("client-1");
});

test("a contender takes over after the initial owner disconnects", async () => {
  const track = new FakeTrack();
  const recorder = new FakeRecorder();
  const statuses: string[] = [];
  let ownerConnected = true;
  const claimRecordingMock = mock(async () =>
    ownerConnected ? ("occupied" as const) : ("claimed" as const),
  );
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    claimRecording: claimRecordingMock,
    reportStatus: async (_assistantId, _event, status) => {
      statuses.push(status);
    },
    waitBeforeRetry: async () => {
      ownerConnected = false;
    },
  });

  await controller.handle(startEvent, "assistant-1");

  expect(claimRecordingMock).toHaveBeenCalledTimes(2);
  expect(recorder.state).toBe("recording");
  expect(statuses).toEqual(["started"]);
});

test("a contender stays eligible after the initial lease window", async () => {
  const track = new FakeTrack();
  const recorder = new FakeRecorder();
  let attempts = 0;
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    claimRecording: async () =>
      ++attempts > 7 ? ("claimed" as const) : ("occupied" as const),
    reportStatus: async () => undefined,
  });

  await controller.handle(startEvent, "assistant-1");

  expect(attempts).toBe(8);
  expect(recorder.state).toBe("recording");
});

test("uses the legacy path when an older assistant lacks claim routes", async () => {
  useAssistantIdentityStore
    .getState()
    .setIdentity("Test Assistant", "0.11.6", "assistant-1");
  const claimRecordingMock = mock(async () => {
    throw new Error("404 Not Found");
  });
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const statuses: string[] = [];
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    claimRecording: claimRecordingMock,
    reportStatus: async (_assistantId, _event, status) => {
      statuses.push(status);
    },
    supportsOwnership: supportsRecordingOwnership,
  });

  await controller.handle(startEvent, "assistant-1");

  expect(claimRecordingMock).not.toHaveBeenCalled();
  expect(recorder.state).toBe("recording");
  expect(statuses).toEqual(["started"]);
});

test("reports remote recording as unsupported on an older assistant", async () => {
  const capture = mock(async () => {
    throw new Error("capture should not start");
  });
  const transfer = mock(async () => ({}));
  const failures: string[] = [];
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
    capture,
    chooseMimeType: () => "video/webm",
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    ownsLifecycle: () => true,
    now: () => 0,
    reportStatus: async (_assistantId, _event, status, details) => {
      if (status === "failed" && details?.error) {
        failures.push(details.error);
      }
    },
    requiresTransfer: () => true,
    supportsOwnership: () => false,
    transferRecording: transfer,
  });

  await controller.handle(startEvent, "assistant-remote");

  expect(capture).not.toHaveBeenCalled();
  expect(transfer).not.toHaveBeenCalled();
  expect(failures).toEqual([
    "Screen recording on another computer requires an updated assistant.",
  ]);
});

const createPendingCancellationController = (overrides: {
  claimRecording?: (
    assistantId: string,
    recordingId: string,
  ) => Promise<"claimed" | "occupied" | "missing">;
  supportsOwnership: () => boolean;
  waitForAssistantVersion: () => Promise<void>;
  waitBeforeRetry?: (delayMs: number) => Promise<void>;
}) => {
  const statuses: string[] = [];
  const capture = mock(async () => {
    throw new Error("capture should not start");
  });
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
    ...overrides,
    capture,
    chooseMimeType: () => "video/webm",
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    ownsLifecycle: () => true,
    now: () => 0,
    reportStatus: async (_assistantId, _event, status) => {
      statuses.push(status);
    },
  });
  return { capture, controller, statuses };
};

test("acknowledges stop while assistant version is resolving", async () => {
  let resolveVersion!: () => void;
  const claim = mock(async () => "claimed" as const);
  const { capture, controller, statuses } = createPendingCancellationController(
    {
      claimRecording: claim,
      supportsOwnership: () => true,
      waitForAssistantVersion: () =>
        new Promise<void>((resolve) => {
          resolveVersion = resolve;
        }),
    },
  );

  const start = controller.handle(startEvent, "assistant-1");
  await Promise.resolve();
  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-1",
  );
  resolveVersion();
  await start;

  expect(claim).toHaveBeenCalledTimes(1);
  expect(statuses).toEqual(["restart_cancelled"]);
  expect(capture).not.toHaveBeenCalled();
});

test("claims once more to acknowledge stop during claim resolution", async () => {
  let resolveClaim!: (outcome: "claimed") => void;
  let firstClaim = true;
  const claim = mock(() => {
    if (!firstClaim) {
      return Promise.resolve("claimed" as const);
    }
    firstClaim = false;
    return new Promise<"claimed">((resolve) => {
      resolveClaim = resolve;
    });
  });
  const { controller, statuses } = createPendingCancellationController({
    claimRecording: claim,
    supportsOwnership: () => true,
    waitForAssistantVersion: async () => undefined,
  });

  const start = controller.handle(startEvent, "assistant-1");
  await Promise.resolve();
  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-1",
  );
  resolveClaim("claimed");
  await start;

  expect(claim).toHaveBeenCalledTimes(2);
  expect(statuses).toEqual(["restart_cancelled"]);
});

test("an occupied contender does not acknowledge another owner's stop", async () => {
  const claim = mock(async () => "occupied" as const);
  let markWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => {
    markWaiting = resolve;
  });
  let continueRetry!: () => void;
  const { controller, statuses } = createPendingCancellationController({
    claimRecording: claim,
    supportsOwnership: () => true,
    waitForAssistantVersion: async () => undefined,
    waitBeforeRetry: () => {
      markWaiting();
      return new Promise<void>((resolve) => {
        continueRetry = resolve;
      });
    },
  });
  const start = controller.handle(startEvent, "assistant-1");
  await waiting;
  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-1",
  );
  continueRetry();
  await start;

  expect(claim).toHaveBeenCalledTimes(2);
  expect(statuses).toEqual([]);
});

test("legacy cancellation acknowledges stop without claiming", async () => {
  let resolveVersion!: () => void;
  const claim = mock(async () => "claimed" as const);
  const { controller, statuses } = createPendingCancellationController({
    claimRecording: claim,
    supportsOwnership: () => false,
    waitForAssistantVersion: () =>
      new Promise<void>((resolve) => {
        resolveVersion = resolve;
      }),
  });

  const start = controller.handle(startEvent, "assistant-1");
  await Promise.resolve();
  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-1",
  );
  resolveVersion();
  await start;

  expect(claim).not.toHaveBeenCalled();
  expect(statuses).toEqual(["restart_cancelled"]);
});

test("waits for an unhydrated assistant version before claiming", async () => {
  const { claimRecordingMock, controller, recorder } =
    createVersionGatedController();

  const start = controller.handle(startEvent, "assistant-1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(claimRecordingMock).not.toHaveBeenCalled();

  useAssistantIdentityStore
    .getState()
    .setIdentity(
      "Test Assistant",
      RECORDING_OWNERSHIP_MIN_VERSION,
      "assistant-1",
    );
  await start;

  expect(claimRecordingMock).toHaveBeenCalledTimes(1);
  expect(recorder.state).toBe("recording");
});

test("waits for the selected assistant version after a switch", async () => {
  useAssistantIdentityStore
    .getState()
    .setIdentity(
      "Previous Assistant",
      RECORDING_OWNERSHIP_MIN_VERSION,
      "assistant-old",
    );
  const { claimRecordingMock, controller, recorder } =
    createVersionGatedController();

  const start = controller.handle(startEvent, "assistant-new");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(claimRecordingMock).not.toHaveBeenCalled();

  useAssistantIdentityStore
    .getState()
    .setIdentity(
      "Selected Assistant",
      RECORDING_OWNERSHIP_MIN_VERSION,
      "assistant-new",
    );
  await start;

  expect(claimRecordingMock).toHaveBeenCalledTimes(1);
  expect(recorder.state).toBe("recording");
});

test("acknowledges a version timeout and accepts a subsequent start", async () => {
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const capture = mock(async () => ({
    stream: {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
    close: () => track.stop(),
  }));
  const statuses: Array<{ recordingId: string; status: string }> = [];
  let ownershipSupport: boolean | null = null;
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
    capture,
    chooseMimeType: () => "video/webm",
    createRecorder: () => recorder as unknown as MediaRecorder,
    ownsLifecycle: () => true,
    now: () => 0,
    reportStatus: async (_assistantId, event, status) => {
      statuses.push({ recordingId: event.recordingId, status });
    },
    supportsOwnership: () => ownershipSupport,
    waitForAssistantVersion: async () => undefined,
  });

  await controller.handle(startEvent, "assistant-1");

  ownershipSupport = true;
  const replacementId = "00000000-0000-4000-8000-000000000002";
  await controller.handle(
    { ...startEvent, recordingId: replacementId },
    "assistant-1",
  );

  expect(statuses).toEqual([
    { recordingId, status: "restart_cancelled" },
    { recordingId: replacementId, status: "started" },
  ]);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(recorder.state).toBe("recording");
});

test("cancels an obsolete start while its version is resolving", async () => {
  const replacementId = "00000000-0000-4000-8000-000000000002";
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const claimRecordingMock = mock(async () => "claimed" as const);
  const statuses: Array<{
    assistantId: string;
    recordingId: string;
    status: string;
  }> = [];
  const versionResolvers = new Map<string, () => void>();
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    claimRecording: claimRecordingMock,
    reportStatus: async (assistantId, event, status) => {
      statuses.push({ assistantId, recordingId: event.recordingId, status });
    },
    supportsOwnership: () => true,
    waitForAssistantVersion: (assistantId) =>
      new Promise<void>((resolve) => {
        versionResolvers.set(assistantId!, resolve);
      }),
  });

  const obsoleteStart = controller.handle(startEvent, "assistant-old");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const replacementStart = controller.handle(
    { ...startEvent, recordingId: replacementId },
    "assistant-new",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  versionResolvers.get("assistant-new")!();
  await replacementStart;
  versionResolvers.get("assistant-old")!();
  await obsoleteStart;

  expect(claimRecordingMock).toHaveBeenCalledTimes(2);
  expect(statuses).toContainEqual({
    assistantId: "assistant-old",
    recordingId,
    status: "restart_cancelled",
  });
  expect(recorder.state).toBe("recording");
});

test("clears a missing contender so a newer recording can start", async () => {
  const replacementId = "00000000-0000-4000-8000-000000000002";
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const capture = mock(async () => ({
    stream: {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
    close: () => track.stop(),
  }));
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
    capture,
    chooseMimeType: () => "video/webm",
    createRecorder: () => recorder as unknown as MediaRecorder,
    ownsLifecycle: () => true,
    now: () => 0,
    claimRecording: async (_assistantId, candidateId) =>
      candidateId === recordingId ? "missing" : "claimed",
    reportStatus: async () => undefined,
  });

  await controller.handle(startEvent, "assistant-1");
  await controller.handle(
    { ...startEvent, recordingId: replacementId },
    "assistant-1",
  );

  expect(capture).toHaveBeenCalledTimes(1);
  expect(recorder.state).toBe("recording");
});

test("a newer recording supersedes an obsolete pending contender", async () => {
  const replacementId = "00000000-0000-4000-8000-000000000002";
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const capture = mock(async () => ({
    stream: {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
    close: () => track.stop(),
  }));
  let markWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => {
    markWaiting = resolve;
  });
  let continueRetry!: () => void;
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
    capture,
    chooseMimeType: () => "video/webm",
    createRecorder: () => recorder as unknown as MediaRecorder,
    ownsLifecycle: () => true,
    now: () => 0,
    claimRecording: async (_assistantId, candidateId) =>
      candidateId === recordingId ? "occupied" : "claimed",
    reportStatus: async () => undefined,
    waitBeforeRetry: () => {
      markWaiting();
      return new Promise<void>((resolve) => {
        continueRetry = resolve;
      });
    },
  });

  const obsoleteStart = controller.handle(startEvent, "assistant-1");
  await waiting;
  await controller.handle(
    { ...startEvent, recordingId: replacementId },
    "assistant-1",
  );
  continueRetry();
  await obsoleteStart;

  expect(capture).toHaveBeenCalledTimes(1);
  expect(recorder.state).toBe("recording");
});

test("stops locally without status after an occupied renewal", async () => {
  const track = new FakeTrack();
  const recorder = new FakeRecorder();
  const statuses: string[] = [];
  let loseClaim!: () => void;
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    maintainClaim: (_assistantId, _recordingId, onLost) => {
      loseClaim = onLost;
      return () => undefined;
    },
    reportStatus: async (_assistantId, _event, status) => {
      statuses.push(status);
    },
  });

  await controller.handle(startEvent, "assistant-1");
  loseClaim();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(recorder.state).toBe("inactive");
  expect(statuses).toEqual(["started"]);
  expect(window.vellum!.screenRecording!.finish).toHaveBeenCalledTimes(1);
  expect(track.stopped).toBeTrue();
});

test("keeps recording after a missing renewal and reports the completed file", async () => {
  const track = new FakeTrack();
  const recorder = new FakeRecorder();
  const statuses: string[] = [];
  let serverStateMissing!: () => void;
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    maintainClaim: (_assistantId, _recordingId, _onLost, onMissing) => {
      serverStateMissing = onMissing;
      return () => undefined;
    },
    reportStatus: async (_assistantId, _event, status) => {
      statuses.push(status);
    },
  });

  await controller.handle(startEvent, "assistant-1");
  serverStateMissing();

  expect(recorder.state).toBe("recording");

  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-1",
  );

  expect(statuses).toEqual(["started", "stopped"]);
  expect(window.vellum!.screenRecording!.finish).toHaveBeenCalledTimes(1);
  expect(track.stopped).toBeTrue();
});

test("replays the complete local recording when transfer state disappears before renewal", async () => {
  const track = new FakeTrack();
  const recorder = new FakeRecorder();
  const transfers: Array<{
    operation: string;
    chunk?: number[];
    sequence?: number;
    attachToConversationId?: string;
  }> = [];
  const stoppedAttachments: string[] = [];
  let initialAppendFinished = false;
  let recoveryBegan = false;
  const completedChunks = [
    { data: new Uint8Array([4, 5, 1]), eof: false },
    { data: new Uint8Array([2, 3]), eof: true },
  ];
  window.vellum!.screenRecording!.read = mock(
    async () =>
      completedChunks.shift() ?? { data: new Uint8Array(), eof: true },
  );
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    reportStatus: async (_assistantId, _event, status, details) => {
      if (status === "stopped" && details?.attachmentId) {
        stoppedAttachments.push(details.attachmentId);
      }
    },
    requiresTransfer: () => true,
    transferRecording: async (
      _assistantId,
      _recordingId,
      operation,
      chunk,
      sequence,
      attachToConversationId,
    ) => {
      transfers.push({
        operation,
        ...(chunk ? { chunk: [...chunk] } : {}),
        ...(sequence !== undefined ? { sequence } : {}),
        ...(attachToConversationId ? { attachToConversationId } : {}),
      });
      if (operation === "append" && sequence === 0) {
        initialAppendFinished = true;
      }
      if (operation === "begin" && attachToConversationId) {
        recoveryBegan = true;
      }
      if (operation === "append" && sequence === 1 && !recoveryBegan) {
        throw new RecordingRequestError(404);
      }
      return operation === "finish"
        ? { attachmentId: "attachment-recovered" }
        : {};
    },
  });

  await controller.handle(startEvent, "assistant-remote");
  recorder.ondataavailable?.({
    data: new Blob([new Uint8Array([4, 5])]),
  } as BlobEvent);
  while (!initialAppendFinished) {
    await Promise.resolve();
  }
  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-remote",
  );

  expect(transfers.filter(({ operation }) => operation === "begin")).toEqual([
    { operation: "begin" },
    { operation: "begin", attachToConversationId: "conv-1" },
  ]);
  expect(transfers.slice(-3)).toEqual([
    { operation: "append", chunk: [4, 5, 1], sequence: 0 },
    { operation: "append", chunk: [2, 3], sequence: 1 },
    { operation: "finish" },
  ]);
  expect(stoppedAttachments).toEqual(["attachment-recovered"]);
  expect(window.vellum!.screenRecording!.release).toHaveBeenCalledWith(
    recordingId,
  );
});

test("a busy controller stays silent when another client owns its queue", async () => {
  const busyClaim = mock(async (_assistantId: string, candidateId: string) =>
    candidateId === recordingId ? "claimed" : "occupied",
  );
  const busyStatuses: string[] = [];
  const makeCapture = async () => {
    const track = new FakeTrack();
    return {
      stream: {
        getTracks: () => [track],
        getVideoTracks: () => [track],
      } as unknown as MediaStream,
      close: () => track.stop(),
    };
  };
  const busy = new ScreenRecordingController({
    ...localTransferDependencies,
    capture: makeCapture,
    chooseMimeType: () => "video/webm",
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    ownsLifecycle: () => true,
    now: () => 0,
    claimRecording: busyClaim,
    reportStatus: async (_assistantId, _event, status) => {
      busyStatuses.push(status);
    },
  });
  const idle = new ScreenRecordingController({
    ...localTransferDependencies,
    capture: makeCapture,
    chooseMimeType: () => "video/webm",
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    ownsLifecycle: () => true,
    now: () => 0,
    reportStatus: async () => undefined,
  });
  const contender = {
    ...startEvent,
    recordingId: "00000000-0000-4000-8000-000000000002",
  };

  await busy.handle(startEvent, "assistant-1");
  const queued = busy.handle(contender, "assistant-1");
  await idle.handle(contender, "assistant-1");
  await busy.handle(
    { type: "recording_stop", recordingId: contender.recordingId },
    "assistant-1",
  );
  await queued;

  expect(busyClaim).toHaveBeenCalledTimes(2);
  expect(busyStatuses).toEqual(["started"]);
});

test("preserves the complete local file when remote retries are exhausted", async () => {
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const errors: string[] = [];
  const transferRecordingMock = mock(
    async (_assistantId: string, _recordingId: string, operation: string) => {
      if (operation === "append") {
        throw new Error("tunnel unavailable");
      }
      return {};
    },
  );
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    reportStatus: async (_assistantId, _event, status, details) => {
      if (status === "failed" && details?.error) {
        errors.push(details.error);
      }
    },
    requiresTransfer: () => true,
    transferRecording: transferRecordingMock,
  });

  await controller.handle(startEvent, "assistant-remote");
  await expect(
    controller.handle(
      { type: "recording_stop", recordingId },
      "assistant-remote",
    ),
  ).rejects.toThrow("tunnel unavailable");

  expect(window.vellum!.screenRecording!.finish).toHaveBeenCalledTimes(1);
  expect(window.vellum!.screenRecording!.release).not.toHaveBeenCalled();
  expect(window.vellum!.screenRecording!.abort).not.toHaveBeenCalled();
  expect(window.vellum!.screenRecording!.append).toHaveBeenCalledTimes(1);
  expect(
    transferRecordingMock.mock.calls.filter(
      ([, , operation]) => operation === "append",
    ),
  ).toHaveLength(4);
  expect(errors).toEqual([
    "Remote recording transfer failed. The complete recording remains saved on this computer.",
  ]);
});

test("preserves the complete local file when finalization is not confirmed", async () => {
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  clientPost.mockResolvedValueOnce({
    data: { ok: true },
    response: { ok: true, status: 200 },
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    clientPost.mockResolvedValueOnce({
      data: { ok: false },
      response: { ok: true, status: 200 },
    });
  }
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    reportStatus: postStatus,
  });

  await controller.handle(startEvent, "assistant-1");
  await expect(
    controller.handle(
      { type: "recording_stop", recordingId },
      "assistant-1",
    ),
  ).rejects.toThrow("Failed to report screen recording status: 200");

  expect(window.vellum!.screenRecording!.finish).toHaveBeenCalledTimes(1);
  expect(window.vellum!.screenRecording!.release).not.toHaveBeenCalled();
  expect(clientPost).toHaveBeenCalledTimes(6);
});

test("retries remote finish after a lost response", async () => {
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  let finishAttempts = 0;
  const transfers: string[] = [];
  const stoppedAttachments: string[] = [];
  const controller = new ScreenRecordingController({
    ...localTransferDependencies,
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
    reportStatus: async (_assistantId, _event, status, details) => {
      if (status === "stopped" && details?.attachmentId) {
        stoppedAttachments.push(details.attachmentId);
      }
    },
    requiresTransfer: () => true,
    transferRecording: async (_assistantId, _recordingId, operation) => {
      transfers.push(operation);
      if (operation === "finish" && finishAttempts++ === 0) {
        throw new Error("response lost after finish");
      }
      return operation === "finish"
        ? { attachmentId: "attachment-remote" }
        : {};
    },
  });

  await controller.handle(startEvent, "assistant-remote");
  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-remote",
  );

  expect(transfers.filter((operation) => operation === "finish")).toHaveLength(
    2,
  );
  expect(stoppedAttachments).toEqual(["attachment-remote"]);
});

test("uses the main-process picker for prompted macOS capture", async () => {
  const stream = {} as MediaStream;
  Object.assign(window.vellum!, {
    hostOS: "macos",
    screenRecording: {
      ...window.vellum!.screenRecording!,
      resolveSource: mock(async () => "screen:1:0"),
    },
  });
  const getDisplayMedia = mock(async () => {
    throw new Error("getDisplayMedia should not be called");
  });
  const getUserMedia = mock(async () => stream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia, getUserMedia },
  });

  await expect(captureSelectedSource(startEvent)).resolves.toBe(stream);

  expect(window.vellum!.screenRecording!.resolveSource).toHaveBeenCalledWith({
    captureScope: undefined,
    displayId: undefined,
    windowId: undefined,
    promptForSource: true,
  });
  expect(getDisplayMedia).not.toHaveBeenCalled();
});

test("requires transfer for paired assistants but not local assistants", () => {
  useResolvedAssistantsStore.setState({
    assistants: [
      {
        id: "assistant-paired",
        isLocal: false,
        isPlatformHosted: false,
        isPaired: true,
      },
      {
        id: "assistant-local",
        isLocal: true,
        isPlatformHosted: false,
        isPaired: false,
      },
    ],
  });

  expect(requiresRecordingTransfer("assistant-paired")).toBeTrue();
  expect(requiresRecordingTransfer("assistant-local")).toBeFalse();
});
