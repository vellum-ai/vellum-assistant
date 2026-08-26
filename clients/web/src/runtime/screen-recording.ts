import type {
  RecordingPauseEvent,
  RecordingResumeEvent,
  RecordingStartEvent,
  RecordingStopEvent,
} from "@vellumai/assistant-api";

import { client } from "@/generated/daemon/client.gen";
import { isElectron } from "@/runtime/is-electron";
import { isPopoutWindowLifetime } from "@/runtime/popout-window";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

type RecordingLifecycleEvent =
  | RecordingStartEvent
  | RecordingStopEvent
  | RecordingPauseEvent
  | RecordingResumeEvent;

type RecordingStatus =
  "started" | "stopped" | "failed" | "restart_cancelled" | "paused" | "resumed";

interface ActiveRecording {
  assistantId: string;
  event: RecordingStartEvent;
  recorder: MediaRecorder;
  stream: MediaStream;
  startedAt: number;
  stopped: Promise<void>;
  stopping: boolean;
  released: boolean;
  closeCapture: () => void;
}

interface PendingRecording {
  recordingId: string;
  cancelled: boolean;
}

interface CapturedMedia {
  stream: MediaStream;
  close: () => void;
}

type KnownDaemonUrl = "/v1/assistants/{assistant_id}/config";

type RecordingTransferOperation = "begin" | "append" | "finish" | "abort";

const postRecordingRequest = async <T>(
  assistantId: string,
  endpoint: "claim" | "transfer",
  body: Record<string, unknown>,
): Promise<T> => {
  const { data, response } = await client.post({
    url: `/v1/assistants/{assistant_id}/recordings/${endpoint}` as KnownDaemonUrl,
    path: { assistant_id: assistantId },
    body,
  });
  if (!response?.ok) {
    throw new Error(`Screen recording request failed: ${response?.status}`);
  }
  return data as T;
};

const claimRecording = async (
  assistantId: string,
  recordingId: string,
): Promise<boolean> => {
  const result = await postRecordingRequest<{ claimed: boolean }>(
    assistantId,
    "claim",
    { recordingId },
  );
  return result.claimed;
};

const encodeChunk = (chunk: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < chunk.length; offset += 32_768) {
    binary += String.fromCharCode(...chunk.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};

export const transferRecording = async (
  assistantId: string,
  recordingId: string,
  operation: RecordingTransferOperation,
  chunk?: Uint8Array,
): Promise<{ attachmentId?: string }> =>
  postRecordingRequest(assistantId, "transfer", {
    recordingId,
    operation,
    ...(chunk ? { data: encodeChunk(chunk) } : {}),
  });

const postStatus = async (
  assistantId: string,
  event: RecordingStartEvent,
  status: RecordingStatus,
  details: {
    filePath?: string;
    attachmentId?: string;
    durationMs?: number;
    error?: string;
  } = {},
): Promise<void> => {
  const { response } = await client.post({
    url: "/v1/assistants/{assistant_id}/recordings/status" as KnownDaemonUrl,
    path: { assistant_id: assistantId },
    body: {
      conversationId: event.recordingId,
      status,
      attachToConversationId: event.attachToConversationId,
      operationToken: event.operationToken,
      ...details,
    } as Record<string, unknown>,
  });
  if (!response?.ok) {
    throw new Error(
      `Failed to report screen recording status: ${response?.status}`,
    );
  }
};

const recorderMimeType = (): string | null => {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
};

export const captureSelectedSource = async (
  event: RecordingStartEvent,
): Promise<MediaStream> => {
  const bridge = window.vellum?.screenRecording;
  if (!bridge) {
    throw new Error("Screen recording bridge is unavailable");
  }
  const options = event.options ?? {};
  const hasSelectedSource =
    options.displayId !== undefined || options.windowId !== undefined;
  const promptForSource = options.promptForSource ?? !hasSelectedSource;

  const sourceId = await bridge.resolveSource({
    captureScope: options.captureScope,
    displayId: options.displayId,
    windowId: options.windowId,
    promptForSource,
  });
  if (!sourceId) {
    if (promptForSource) {
      throw new DOMException("Source selection cancelled", "NotAllowedError");
    }
    throw new Error("The requested recording source is unavailable");
  }
  const desktopConstraint = {
    mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: sourceId,
    },
  } as unknown as MediaTrackConstraints;
  return navigator.mediaDevices.getUserMedia({
    video: desktopConstraint,
    audio: options.includeAudio ? desktopConstraint : false,
  });
};

const captureStream = async (
  event: RecordingStartEvent,
): Promise<CapturedMedia> => {
  const displayStream = await captureSelectedSource(event);
  if (!event.options?.includeMicrophone) {
    return {
      stream: displayStream,
      close: () => {
        for (const track of displayStream.getTracks()) {
          track.stop();
        }
      },
    };
  }
  try {
    const microphone = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    const audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    for (const sourceStream of [displayStream, microphone]) {
      if (sourceStream.getAudioTracks().length > 0) {
        audioContext.createMediaStreamSource(sourceStream).connect(destination);
      }
    }
    const stream = new MediaStream([
      ...displayStream.getVideoTracks(),
      ...destination.stream.getAudioTracks(),
    ]);
    return {
      stream,
      close: () => {
        for (const track of [
          ...displayStream.getTracks(),
          ...microphone.getTracks(),
          ...stream.getTracks(),
        ]) {
          track.stop();
        }
        void audioContext.close();
      },
    };
  } catch (error) {
    for (const track of displayStream.getTracks()) {
      track.stop();
    }
    throw error;
  }
};

const isPickerCancellation = (error: unknown): boolean =>
  error instanceof DOMException &&
  ["AbortError", "NotAllowedError"].includes(error.name);

export const requiresRecordingTransfer = (assistantId: string): boolean => {
  const assistant = useResolvedAssistantsStore
    .getState()
    .assistants.find((entry) => entry.id === assistantId);
  return !assistant || assistant.isPaired || !assistant.isLocal;
};

export class ScreenRecordingController {
  private active: ActiveRecording | null = null;
  private pending: PendingRecording | null = null;

  constructor(
    private readonly dependencies: {
      capture: typeof captureStream;
      chooseMimeType: typeof recorderMimeType;
      createRecorder: (stream: MediaStream, mimeType: string) => MediaRecorder;
      ownsLifecycle: () => boolean;
      now: () => number;
      reportStatus: typeof postStatus;
      claimRecording: typeof claimRecording;
      requiresTransfer: typeof requiresRecordingTransfer;
      transferRecording: typeof transferRecording;
    } = {
      capture: captureStream,
      chooseMimeType: recorderMimeType,
      createRecorder: (stream, mimeType) =>
        new MediaRecorder(stream, { mimeType }),
      ownsLifecycle: () => !isPopoutWindowLifetime(),
      now: Date.now,
      reportStatus: postStatus,
      claimRecording,
      requiresTransfer: requiresRecordingTransfer,
      transferRecording,
    },
  ) {}

  async handle(
    event: RecordingLifecycleEvent,
    assistantId: string,
  ): Promise<void> {
    if (
      !isElectron() ||
      !window.vellum?.screenRecording ||
      !this.dependencies.ownsLifecycle()
    ) {
      return;
    }
    switch (event.type) {
      case "recording_start":
        await this.start(event, assistantId);
        break;
      case "recording_stop":
        await this.stop(event.recordingId);
        break;
      case "recording_pause":
        await this.pause(event.recordingId);
        break;
      case "recording_resume":
        await this.resume(event.recordingId);
        break;
    }
  }

  private async start(
    event: RecordingStartEvent,
    assistantId: string,
  ): Promise<void> {
    const bridge = window.vellum!.screenRecording!;
    if (this.active || this.pending) {
      await this.dependencies.reportStatus(assistantId, event, "failed", {
        error: "A screen recording is already active",
      });
      return;
    }
    if (
      !(await this.dependencies.claimRecording(assistantId, event.recordingId))
    ) {
      return;
    }

    const pending: PendingRecording = {
      recordingId: event.recordingId,
      cancelled: false,
    };
    this.pending = pending;
    let capture: CapturedMedia | null = null;
    let recorder: MediaRecorder | null = null;
    let fileStarted = false;
    let transferStarted = false;
    const requiresTransfer = this.dependencies.requiresTransfer(assistantId);
    try {
      const mimeType = this.dependencies.chooseMimeType();
      if (!mimeType) {
        throw new Error("This desktop cannot encode a screen recording");
      }
      capture = await this.dependencies.capture(event);
      if (pending.cancelled) {
        capture.close();
        capture = null;
        await this.dependencies.reportStatus(assistantId, event, "stopped");
        return;
      }
      if (requiresTransfer) {
        await this.dependencies.transferRecording(
          assistantId,
          event.recordingId,
          "begin",
        );
        transferStarted = true;
      }
      await bridge.begin(event.recordingId);
      fileStarted = true;
      if (pending.cancelled) {
        capture.close();
        capture = null;
        await bridge.abort(event.recordingId);
        fileStarted = false;
        if (transferStarted) {
          await this.dependencies.transferRecording(
            assistantId,
            event.recordingId,
            "abort",
          );
          transferStarted = false;
        }
        await this.dependencies.reportStatus(assistantId, event, "stopped");
        return;
      }

      recorder = this.dependencies.createRecorder(capture.stream, mimeType);
      let writes = Promise.resolve();
      recorder.ondataavailable = (dataEvent) => {
        if (dataEvent.data.size === 0) {
          return;
        }
        writes = writes.then(async () => {
          const bytes = new Uint8Array(await dataEvent.data.arrayBuffer());
          await bridge.append(event.recordingId, bytes);
          if (requiresTransfer) {
            await this.dependencies.transferRecording(
              assistantId,
              event.recordingId,
              "append",
              bytes,
            );
          }
        });
      };

      let resolveStopped!: () => void;
      let rejectStopped!: (error: unknown) => void;
      const stopped = new Promise<void>((resolve, reject) => {
        resolveStopped = resolve;
        rejectStopped = reject;
      });
      const active: ActiveRecording = {
        assistantId,
        event,
        recorder,
        stream: capture.stream,
        startedAt: this.dependencies.now(),
        stopped,
        stopping: false,
        released: false,
        closeCapture: capture.close,
      };
      recorder.onstop = () => {
        void (async () => {
          try {
            await writes;
            const { filePath } = await bridge.finish(event.recordingId);
            let attachmentId: string | undefined;
            if (requiresTransfer) {
              const uploaded = await this.dependencies.transferRecording(
                assistantId,
                event.recordingId,
                "finish",
              );
              if (!uploaded.attachmentId) {
                throw new Error(
                  "Recording transfer did not return an attachment",
                );
              }
              attachmentId = uploaded.attachmentId;
              transferStarted = false;
            }
            this.release(active);
            await this.dependencies.reportStatus(
              assistantId,
              event,
              "stopped",
              {
                ...(attachmentId ? { attachmentId } : { filePath }),
                durationMs: this.dependencies.now() - active.startedAt,
              },
            );
            resolveStopped();
          } catch (error) {
            await bridge.abort(event.recordingId);
            if (transferStarted) {
              await this.dependencies
                .transferRecording(assistantId, event.recordingId, "abort")
                .catch(() => undefined);
              transferStarted = false;
            }
            this.release(active);
            await this.dependencies
              .reportStatus(assistantId, event, "failed", {
                error: error instanceof Error ? error.message : String(error),
              })
              .catch(() => undefined);
            rejectStopped(error);
          } finally {
            this.release(active);
          }
        })();
      };
      if (this.pending === pending) {
        this.pending = null;
      }
      this.active = active;
      for (const track of capture.stream.getVideoTracks()) {
        track.addEventListener("ended", () => {
          void this.stop(event.recordingId).catch(() => undefined);
        });
      }
      recorder.start(1_000);
      await this.dependencies.reportStatus(assistantId, event, "started");
    } catch (error) {
      if (recorder) {
        recorder.onstop = null;
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
      }
      if (this.active?.event.recordingId === event.recordingId) {
        this.active = null;
      }
      capture?.close();
      if (fileStarted) {
        await bridge.abort(event.recordingId);
      }
      if (transferStarted) {
        await this.dependencies
          .transferRecording(assistantId, event.recordingId, "abort")
          .catch(() => undefined);
      }
      if (pending.cancelled) {
        await this.dependencies.reportStatus(assistantId, event, "stopped");
        return;
      }
      await this.dependencies.reportStatus(
        assistantId,
        event,
        event.operationToken && isPickerCancellation(error)
          ? "restart_cancelled"
          : "failed",
        { error: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      if (this.pending === pending) {
        this.pending = null;
      }
    }
  }

  private async stop(recordingId: string): Promise<void> {
    if (this.pending?.recordingId === recordingId) {
      this.pending.cancelled = true;
      return;
    }
    const active = this.active;
    if (!active || active.event.recordingId !== recordingId) {
      return;
    }
    if (active.stopping) {
      await active.stopped;
      return;
    }
    active.stopping = true;
    if (active.recorder.state !== "inactive") {
      active.recorder.stop();
    }
    await active.stopped;
  }

  private release(active: ActiveRecording): void {
    if (active.released) {
      return;
    }
    active.released = true;
    active.closeCapture();
    if (this.active === active) {
      this.active = null;
    }
  }

  private async pause(recordingId: string): Promise<void> {
    const active = this.active;
    if (
      !active ||
      active.event.recordingId !== recordingId ||
      active.recorder.state !== "recording"
    ) {
      return;
    }
    active.recorder.pause();
    await this.dependencies.reportStatus(
      active.assistantId,
      active.event,
      "paused",
    );
  }

  private async resume(recordingId: string): Promise<void> {
    const active = this.active;
    if (
      !active ||
      active.event.recordingId !== recordingId ||
      active.recorder.state !== "paused"
    ) {
      return;
    }
    active.recorder.resume();
    await this.dependencies.reportStatus(
      active.assistantId,
      active.event,
      "resumed",
    );
  }
}

const controller = new ScreenRecordingController();

export const handleScreenRecordingEvent = (
  event: RecordingLifecycleEvent,
  assistantId: string,
): Promise<void> => controller.handle(event, assistantId);
