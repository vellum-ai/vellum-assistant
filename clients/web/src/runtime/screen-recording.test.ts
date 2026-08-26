import { beforeEach, expect, mock, test } from "bun:test";
import {
  MIN_VERSION as RECORDING_OWNERSHIP_MIN_VERSION,
  supportsRecordingOwnership,
} from "@/lib/backwards-compat/recording-ownership";
import { whenAssistantVersionKnownFor } from "@/lib/backwards-compat/utils";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const clientPost = mock(async () => ({
  data: {} as unknown,
  response: { ok: true, status: 200 },
}));
mock.module("@/generated/daemon/client.gen", () => ({
  client: { post: clientPost },
}));

const {
  ScreenRecordingController,
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

  expect(statuses).toEqual(["stopped"]);
  expect(track.stopped).toBeTrue();
  expect(recorder.state).toBe("inactive");
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

test("cancels an obsolete start while its version is resolving", async () => {
  const replacementId = "00000000-0000-4000-8000-000000000002";
  const recorder = new FakeRecorder();
  const track = new FakeTrack();
  const claimRecordingMock = mock(async () => "claimed" as const);
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
    reportStatus: async () => undefined,
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

  expect(claimRecordingMock).toHaveBeenCalledTimes(1);
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

test("replays the complete local recording after remote transfer state is lost", async () => {
  const track = new FakeTrack();
  const recorder = new FakeRecorder();
  let serverStateMissing!: () => void;
  const transfers: Array<{
    operation: string;
    chunk?: number[];
    sequence?: number;
    attachToConversationId?: string;
  }> = [];
  const stoppedAttachments: string[] = [];
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
    maintainClaim: (_assistantId, _recordingId, _onLost, onMissing) => {
      serverStateMissing = onMissing;
      return () => undefined;
    },
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
      return operation === "finish"
        ? { attachmentId: "attachment-recovered" }
        : {};
    },
  });

  await controller.handle(startEvent, "assistant-remote");
  recorder.ondataavailable?.({
    data: new Blob([new Uint8Array([4, 5])]),
  } as BlobEvent);
  await Promise.resolve();
  serverStateMissing();
  await controller.handle(
    { type: "recording_stop", recordingId },
    "assistant-remote",
  );

  expect(transfers).toEqual([
    { operation: "begin" },
    { operation: "append", chunk: [4, 5], sequence: 0 },
    { operation: "begin", attachToConversationId: "conv-1" },
    { operation: "append", chunk: [4, 5, 1], sequence: 0 },
    { operation: "append", chunk: [2, 3], sequence: 1 },
    { operation: "finish" },
  ]);
  expect(stoppedAttachments).toEqual(["attachment-recovered"]);
  expect(window.vellum!.screenRecording!.release).toHaveBeenCalledWith(
    recordingId,
  );
});

test("a busy non-owner stays silent so an idle client can claim", async () => {
  const busyClaim = mock(async () => "claimed" as const);
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
  await busy.handle(contender, "assistant-1");
  await idle.handle(contender, "assistant-1");

  expect(busyClaim).toHaveBeenCalledTimes(1);
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
