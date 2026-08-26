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
  ownershipLost: boolean;
  closeCapture: () => void;
  stopClaimMaintenance: () => void;
}

interface PendingRecording {
  recordingId: string;
  cancelled: boolean;
  ownershipLost: boolean;
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
  sequence?: number,
): Promise<{ attachmentId?: string }> =>
  postRecordingRequest(assistantId, "transfer", {
    recordingId,
    operation,
    ...(chunk ? { data: encodeChunk(chunk) } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
  });

const maintainRecordingClaim = (
  assistantId: string,
  recordingId: string,
  onLost: () => void,
): (() => void) => {
  let stopped = false;
  let checking = false;
  const timer = setInterval(() => {
    if (checking) {
      return;
    }
    checking = true;
    void claimRecording(assistantId, recordingId)
      .then((claimed) => {
        if (!claimed && !stopped) {
          stopped = true;
          clearInterval(timer);
          onLost();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        checking = false;
      });
  }, 10_000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
};

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
      maintainClaim: typeof maintainRecordingClaim;
      requiresTransfer: typeof requiresRecordingTransfer;
      transferRecording: typeof transferRecording;
      waitBeforeRetry: (delayMs: number) => Promise<void>;
    } = {
      capture: captureStream,
      chooseMimeType: recorderMimeType,
      createRecorder: (stream, mimeType) =>
        new MediaRecorder(stream, { mimeType }),
      ownsLifecycle: () => !isPopoutWindowLifetime(),
      now: Date.now,
      reportStatus: postStatus,
      claimRecording,
      maintainClaim: maintainRecordingClaim,
      requiresTransfer: requiresRecordingTransfer,
      transferRecording,
      waitBeforeRetry: (delayMs) =>
        new Promise((resolve) => setTimeout(resolve, delayMs)),
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
      return;
    }
    const pending: PendingRecording = {
      recordingId: event.recordingId,
      cancelled: false,
      ownershipLost: false,
    };
    this.pending = pending;
    if (!(await this.claimWithRetry(assistantId, pending))) {
      if (this.pending === pending) {
        this.pending = null;
      }
      return;
    }
    const stopClaimMaintenance = this.dependencies.maintainClaim(
      assistantId,
      event.recordingId,
      () => this.loseOwnership(event.recordingId),
    );
    let capture: CapturedMedia | null = null;
    let recorder: MediaRecorder | null = null;
    let fileStarted = false;
    let transferStarted = false;
    const requiresTransfer = this.dependencies.requiresTransfer(assistantId);
    try {
      if (pending.cancelled) {
        if (!pending.ownershipLost) {
          await this.dependencies.reportStatus(assistantId, event, "stopped");
        }
        return;
      }
      const mimeType = this.dependencies.chooseMimeType();
      if (!mimeType) {
        throw new Error("This desktop cannot encode a screen recording");
      }
      capture = await this.dependencies.capture(event);
      if (pending.cancelled) {
        capture.close();
        capture = null;
        if (!pending.ownershipLost) {
          await this.dependencies.reportStatus(assistantId, event, "stopped");
        }
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
        if (!pending.ownershipLost) {
          await this.dependencies.reportStatus(assistantId, event, "stopped");
        }
        return;
      }

      recorder = this.dependencies.createRecorder(capture.stream, mimeType);
      let localWrites = Promise.resolve();
      let transferWrites = Promise.resolve();
      let chunkSequence = 0;
      recorder.ondataavailable = (dataEvent) => {
        if (dataEvent.data.size === 0) {
          return;
        }
        const bytes = dataEvent.data
          .arrayBuffer()
          .then((buffer) => new Uint8Array(buffer));
        localWrites = localWrites.then(async () => {
          await bridge.append(event.recordingId, await bytes);
        });
        if (requiresTransfer) {
          const sequence = chunkSequence++;
          transferWrites = transferWrites.then(async () => {
            await this.transferWithRetry(
              assistantId,
              event.recordingId,
              "append",
              await bytes,
              sequence,
            );
          });
        }
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
        ownershipLost: false,
        closeCapture: capture.close,
        stopClaimMaintenance,
      };
      recorder.onstop = () => {
        void (async () => {
          let localFinished = false;
          try {
            await localWrites;
            const { filePath } = await bridge.finish(event.recordingId);
            localFinished = true;
            if (active.ownershipLost) {
              void transferWrites.catch(() => undefined);
              this.release(active);
              resolveStopped();
              return;
            }
            await transferWrites;
            let attachmentId: string | undefined;
            if (requiresTransfer) {
              const uploaded = await this.transferWithRetry(
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
            if (!localFinished) {
              await bridge.abort(event.recordingId);
            }
            if (active.ownershipLost) {
              void transferWrites.catch(() => undefined);
              this.release(active);
              resolveStopped();
              return;
            }
            if (transferStarted) {
              await this.dependencies
                .transferRecording(assistantId, event.recordingId, "abort")
                .catch(() => undefined);
              transferStarted = false;
            }
            this.release(active);
            await this.dependencies
              .reportStatus(assistantId, event, "failed", {
                error:
                  localFinished && requiresTransfer
                    ? "Remote recording transfer failed. The complete recording remains saved on this computer."
                    : error instanceof Error
                      ? error.message
                      : String(error),
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
      const ownershipLost =
        pending.ownershipLost ||
        (this.active?.event.recordingId === event.recordingId &&
          this.active.ownershipLost);
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
      if (transferStarted && !ownershipLost) {
        await this.dependencies
          .transferRecording(assistantId, event.recordingId, "abort")
          .catch(() => undefined);
      }
      if (ownershipLost) {
        return;
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
      if (this.active?.event.recordingId !== event.recordingId) {
        stopClaimMaintenance();
      }
    }
  }

  private async claimWithRetry(
    assistantId: string,
    pending: PendingRecording,
  ): Promise<boolean> {
    let retryDelayMs = 1_000;
    while (!pending.cancelled) {
      try {
        if (
          await this.dependencies.claimRecording(
            assistantId,
            pending.recordingId,
          )
        ) {
          return true;
        }
      } catch {
        // Retry while the recording may still need an owner.
      }
      await this.dependencies.waitBeforeRetry(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
    }
    return false;
  }

  private async transferWithRetry(
    assistantId: string,
    recordingId: string,
    operation: "append" | "finish",
    chunk?: Uint8Array,
    sequence?: number,
  ): Promise<{ attachmentId?: string }> {
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.dependencies.transferRecording(
          assistantId,
          recordingId,
          operation,
          chunk,
          sequence,
        );
      } catch (error) {
        if (attempt === maxAttempts - 1) {
          throw error;
        }
        await this.dependencies.waitBeforeRetry(250 * 2 ** attempt);
      }
    }
    throw new Error("Recording transfer retry loop exhausted");
  }

  private loseOwnership(recordingId: string): void {
    if (this.pending?.recordingId === recordingId) {
      this.pending.cancelled = true;
      this.pending.ownershipLost = true;
    }
    const active = this.active;
    if (!active || active.event.recordingId !== recordingId) {
      return;
    }
    active.ownershipLost = true;
    active.stopClaimMaintenance();
    if (active.recorder.state !== "inactive") {
      active.recorder.stop();
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
    active.stopClaimMaintenance();
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
