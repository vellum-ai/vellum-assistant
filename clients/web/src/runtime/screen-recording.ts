import type {
  RecordingPauseEvent,
  RecordingResumeEvent,
  RecordingStartEvent,
  RecordingStopEvent,
} from "@vellumai/assistant-api";

import { client } from "@/generated/daemon/client.gen";
import { supportsRecordingOwnership } from "@/lib/backwards-compat/recording-ownership";
import { whenAssistantVersionKnownFor } from "@/lib/backwards-compat/utils";
import { getDeviceId } from "@/runtime/device-id";
import { isElectron } from "@/runtime/is-electron";
import { isPopoutWindowLifetime } from "@/runtime/popout-window";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

type RecordingLifecycleEvent =
  | RecordingStartEvent
  | RecordingStopEvent
  | RecordingPauseEvent
  | RecordingResumeEvent;

type RecordingStatus =
  | "started"
  | "stopped"
  | "failed"
  | "restart_cancelled"
  | "paused"
  | "resumed";

interface RecordingStatusDetails {
  filePath?: string;
  attachmentId?: string;
  durationMs?: number;
  error?: string;
}

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
  restartRecovery: boolean;
  closeCapture: () => void;
  stopClaimMaintenance: () => void;
}

interface PendingRecording {
  assistantId: string;
  recordingId: string;
  cancelled: boolean;
  claimed: boolean;
  ownershipLost: boolean;
}

interface QueuedRecording {
  assistantId: string;
  event: RecordingStartEvent;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface CapturedMedia {
  stream: MediaStream;
  close: () => void;
}

type KnownDaemonUrl = "/v1/assistants/{assistant_id}/config";

type RecordingTransferOperation = "begin" | "append" | "finish" | "abort";
type RecordingClaimOutcome = "claimed" | "occupied" | "missing";

export class RecordingRequestError extends Error {
  constructor(readonly status: number | undefined) {
    super(`Screen recording request failed: ${status}`);
  }
}

const isMissingRecordingState = (error: unknown): boolean =>
  error instanceof RecordingRequestError && error.status === 404;

const postRecordingRequest = async <T>(
  assistantId: string,
  endpoint: "claim" | "transfer",
  body: Record<string, unknown>,
): Promise<T> => {
  const desktopClientId = getDeviceId();
  const { data, response } = await client.post({
    url: `/v1/assistants/{assistant_id}/recordings/${endpoint}` as KnownDaemonUrl,
    path: { assistant_id: assistantId },
    body,
    ...(desktopClientId
      ? { headers: { "Vellum-Device-Id": desktopClientId } }
      : {}),
  });
  if (!response?.ok) {
    throw new RecordingRequestError(response?.status);
  }
  return data as T;
};

const claimRecording = async (
  assistantId: string,
  recordingId: string,
): Promise<RecordingClaimOutcome> => {
  const result = await postRecordingRequest<{
    claimed: boolean;
    outcome: RecordingClaimOutcome;
  }>(assistantId, "claim", { recordingId });
  return result.outcome;
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
  attachToConversationId?: string,
): Promise<{ attachmentId?: string }> =>
  postRecordingRequest(assistantId, "transfer", {
    recordingId,
    operation,
    ...(chunk ? { data: encodeChunk(chunk) } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(attachToConversationId ? { attachToConversationId } : {}),
  });

const maintainRecordingClaim = (
  assistantId: string,
  recordingId: string,
  onLost: () => void,
  onMissing: () => void,
): (() => void) => {
  let stopped = false;
  let checking = false;
  const timer = setInterval(() => {
    if (checking) {
      return;
    }
    checking = true;
    void claimRecording(assistantId, recordingId)
      .then((outcome) => {
        if (outcome === "missing" && !stopped) {
          stopped = true;
          clearInterval(timer);
          onMissing();
        } else if (outcome === "occupied" && !stopped) {
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

export const postStatus = async (
  assistantId: string,
  event: RecordingStartEvent,
  status: RecordingStatus,
  details: RecordingStatusDetails = {},
): Promise<void> => {
  const desktopClientId = getDeviceId();
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
    ...(desktopClientId
      ? { headers: { "Vellum-Device-Id": desktopClientId } }
      : {}),
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
  private readonly queuedStarts = new Map<string, QueuedRecording>();
  private drainingQueuedStart = false;

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
      supportsOwnership: typeof supportsRecordingOwnership;
      transferRecording: typeof transferRecording;
      waitForAssistantVersion: typeof whenAssistantVersionKnownFor;
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
      supportsOwnership: supportsRecordingOwnership,
      transferRecording,
      waitForAssistantVersion: whenAssistantVersionKnownFor,
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
        await this.stop(event.recordingId, assistantId);
        break;
      case "recording_pause":
        await this.pause(event.recordingId);
        break;
      case "recording_resume":
        await this.resume(event.recordingId);
        break;
    }
  }

  async handleAssistantChange(assistantId: string | null): Promise<void> {
    if (
      !isElectron() ||
      !window.vellum?.screenRecording ||
      !this.dependencies.ownsLifecycle()
    ) {
      return;
    }
    await this.finalizeLifecycleWork(assistantId);
  }

  async handleLifecycleOwnerUnmount(): Promise<void> {
    if (
      !isElectron() ||
      !window.vellum?.screenRecording ||
      !this.dependencies.ownsLifecycle()
    ) {
      return;
    }
    await this.finalizeLifecycleWork(null);
  }

  private async finalizeLifecycleWork(
    keptAssistantId: string | null,
  ): Promise<void> {
    if (this.pending && this.pending.assistantId !== keptAssistantId) {
      this.pending.cancelled = true;
    }
    const queuedCancellations = [...this.queuedStarts.values()]
      .filter((queued) => queued.assistantId !== keptAssistantId)
      .map((queued) =>
        this.cancelQueuedStart(queued.event.recordingId, queued.assistantId),
      );
    const active = this.active;
    const activeStop =
      active && active.assistantId !== keptAssistantId
        ? this.stop(active.event.recordingId, active.assistantId)
        : Promise.resolve();
    await Promise.all([activeStop, ...queuedCancellations]);
  }

  private async start(
    event: RecordingStartEvent,
    assistantId: string,
  ): Promise<void> {
    const bridge = window.vellum!.screenRecording!;
    if (this.active) {
      if (
        this.active.assistantId === assistantId &&
        this.active.event.recordingId === event.recordingId
      ) {
        return;
      }
      await this.enqueueStart(event, assistantId);
      return;
    }
    if (this.pending) {
      if (
        this.pending.assistantId === assistantId &&
        this.pending.recordingId === event.recordingId
      ) {
        return;
      }
      if (this.pending.claimed) {
        await this.enqueueStart(event, assistantId);
        return;
      }
      this.pending.cancelled = true;
      this.pending = null;
    }
    const pending: PendingRecording = {
      assistantId,
      recordingId: event.recordingId,
      cancelled: false,
      claimed: false,
      ownershipLost: false,
    };
    this.pending = pending;
    await this.dependencies.waitForAssistantVersion(assistantId);
    if (this.pending !== pending) {
      if (pending.cancelled) {
        await this.acknowledgePendingCancellation(
          assistantId,
          event,
          pending,
          this.dependencies.supportsOwnership(assistantId) ?? false,
        );
      }
      return;
    }
    const ownershipSupport = this.dependencies.supportsOwnership(assistantId);
    if (ownershipSupport === null) {
      try {
        await this.reportStatusWithRetry(
          assistantId,
          event,
          "restart_cancelled",
        );
      } finally {
        if (this.pending === pending) {
          this.pending = null;
        }
      }
      return;
    }
    const usesOwnership = ownershipSupport;
    const requiresTransfer = this.dependencies.requiresTransfer(assistantId);
    pending.claimed = !usesOwnership;
    if (pending.cancelled) {
      await this.acknowledgePendingCancellation(
        assistantId,
        event,
        pending,
        usesOwnership,
      );
      if (this.pending === pending) {
        this.pending = null;
      }
      return;
    }
    if (requiresTransfer && !usesOwnership) {
      this.pending = null;
      await this.dependencies.reportStatus(assistantId, event, "failed", {
        error:
          "Screen recording on another computer requires an updated assistant.",
      });
      return;
    }
    if (usesOwnership && !(await this.claimWithRetry(assistantId, pending))) {
      if (pending.cancelled) {
        await this.acknowledgePendingCancellation(
          assistantId,
          event,
          pending,
          usesOwnership,
        );
      }
      if (this.pending === pending) {
        this.pending = null;
      }
      return;
    }
    const stopClaimMaintenance = usesOwnership
      ? this.dependencies.maintainClaim(
          assistantId,
          event.recordingId,
          () => this.loseOwnership(event.recordingId),
          () => this.keepAliveAfterServerRestart(event.recordingId),
        )
      : () => undefined;
    let capture: CapturedMedia | null = null;
    let recorder: MediaRecorder | null = null;
    let fileStarted = false;
    let transferStarted = false;
    try {
      if (pending.cancelled) {
        if (!pending.ownershipLost) {
          await this.reportStatusWithRetry(
            assistantId,
            event,
            "restart_cancelled",
          );
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
          await this.reportStatusWithRetry(
            assistantId,
            event,
            "restart_cancelled",
          );
        }
        return;
      }
      if (requiresTransfer) {
        transferStarted = true;
        await this.transferWithRetry(assistantId, event.recordingId, "begin");
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
          await this.reportStatusWithRetry(
            assistantId,
            event,
            "restart_cancelled",
          );
        }
        return;
      }

      recorder = this.dependencies.createRecorder(capture.stream, mimeType);
      let localWrites = Promise.resolve();
      let transferWrites = Promise.resolve();
      let chunkSequence = 0;
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
        restartRecovery: false,
        closeCapture: capture.close,
        stopClaimMaintenance,
      };
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
        if (requiresTransfer && !active.restartRecovery) {
          const sequence = chunkSequence++;
          transferWrites = transferWrites.then(async () => {
            try {
              await this.transferWithRetry(
                assistantId,
                event.recordingId,
                "append",
                await bytes,
                sequence,
              );
            } catch (error) {
              if (isMissingRecordingState(error)) {
                active.restartRecovery = true;
                active.stopClaimMaintenance();
                return;
              }
              throw error;
            }
          });
        }
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
            let attachmentId: string | undefined;
            if (requiresTransfer) {
              await transferWrites.catch((error) => {
                if (!active.restartRecovery) {
                  throw error;
                }
              });
              let uploaded: { attachmentId?: string };
              if (active.restartRecovery) {
                uploaded = await this.replayCompletedRecording(active, bridge);
              } else {
                try {
                  uploaded = await this.transferWithRetry(
                    assistantId,
                    event.recordingId,
                    "finish",
                  );
                } catch (error) {
                  if (!isMissingRecordingState(error)) {
                    throw error;
                  }
                  active.restartRecovery = true;
                  active.stopClaimMaintenance();
                  uploaded = await this.replayCompletedRecording(
                    active,
                    bridge,
                  );
                }
              }
              if (!uploaded.attachmentId) {
                throw new Error(
                  "Recording transfer did not return an attachment",
                );
              }
              attachmentId = uploaded.attachmentId;
              transferStarted = false;
            }
            this.release(active);
            await this.reportStatusWithRetry(assistantId, event, "stopped", {
              ...(attachmentId ? { attachmentId } : { filePath }),
              durationMs: this.dependencies.now() - active.startedAt,
            });
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
            if (localFinished) {
              await bridge.release(event.recordingId).catch(() => undefined);
            }
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
          void this.stop(event.recordingId, assistantId).catch(() => undefined);
        });
      }
      recorder.start(1_000);
      await this.reportStatusWithRetry(assistantId, event, "started");
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
        await this.reportStatusWithRetry(
          assistantId,
          event,
          "restart_cancelled",
        );
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
      if (!this.active && !this.pending) {
        this.drainQueuedStarts();
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
        const outcome = await this.dependencies.claimRecording(
          assistantId,
          pending.recordingId,
        );
        if (pending.cancelled) {
          return false;
        }
        if (outcome === "claimed") {
          pending.claimed = true;
          return true;
        }
        if (outcome === "missing") {
          pending.cancelled = true;
          return false;
        }
      } catch {
        // Retry while the recording may still need an owner.
      }
      await this.dependencies.waitBeforeRetry(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
    }
    return false;
  }

  private async acknowledgePendingCancellation(
    assistantId: string,
    event: RecordingStartEvent,
    pending: PendingRecording,
    usesOwnership: boolean,
  ): Promise<void> {
    if (pending.ownershipLost) {
      return;
    }
    if (usesOwnership && !pending.claimed) {
      try {
        const outcome = await this.dependencies.claimRecording(
          assistantId,
          event.recordingId,
        );
        if (outcome !== "claimed") {
          return;
        }
        pending.claimed = true;
      } catch {
        return;
      }
    }
    await this.reportStatusWithRetry(assistantId, event, "restart_cancelled");
  }

  private queuedStartKey(assistantId: string, recordingId: string): string {
    return `${assistantId}:${recordingId}`;
  }

  private enqueueStart(
    event: RecordingStartEvent,
    assistantId: string,
  ): Promise<void> {
    const key = this.queuedStartKey(assistantId, event.recordingId);
    const existing = this.queuedStarts.get(key);
    if (existing) {
      return existing.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.queuedStarts.set(key, {
      assistantId,
      event,
      promise,
      resolve,
      reject,
    });
    return promise;
  }

  private async cancelQueuedStart(
    recordingId: string,
    assistantId: string,
  ): Promise<boolean> {
    const key = this.queuedStartKey(assistantId, recordingId);
    const queued = this.queuedStarts.get(key);
    if (!queued) {
      return false;
    }
    this.queuedStarts.delete(key);
    try {
      await this.acknowledgeQueuedCancellation(queued);
      queued.resolve();
    } catch (error) {
      queued.reject(error);
      throw error;
    }
    return true;
  }

  private async acknowledgeQueuedCancellation(
    queued: QueuedRecording,
  ): Promise<void> {
    await this.dependencies.waitForAssistantVersion(queued.assistantId);
    const ownershipSupport = this.dependencies.supportsOwnership(
      queued.assistantId,
    );
    if (ownershipSupport) {
      const outcome = await this.dependencies.claimRecording(
        queued.assistantId,
        queued.event.recordingId,
      );
      if (outcome !== "claimed") {
        return;
      }
    }
    await this.reportStatusWithRetry(
      queued.assistantId,
      queued.event,
      "restart_cancelled",
    );
  }

  private drainQueuedStarts(): void {
    if (this.drainingQueuedStart || this.active || this.pending) {
      return;
    }
    const queued = this.queuedStarts.values().next().value as
      | QueuedRecording
      | undefined;
    if (!queued) {
      return;
    }
    this.queuedStarts.delete(
      this.queuedStartKey(queued.assistantId, queued.event.recordingId),
    );
    this.drainingQueuedStart = true;
    void this.start(queued.event, queued.assistantId)
      .then(queued.resolve, queued.reject)
      .finally(() => {
        this.drainingQueuedStart = false;
        this.drainQueuedStarts();
      });
  }

  private async reportStatusWithRetry(
    assistantId: string,
    event: RecordingStartEvent,
    status: RecordingStatus,
    details: RecordingStatusDetails = {},
  ): Promise<void> {
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await this.dependencies.reportStatus(
          assistantId,
          event,
          status,
          details,
        );
        return;
      } catch (error) {
        if (attempt === maxAttempts - 1) {
          throw error;
        }
        await this.dependencies.waitBeforeRetry(250 * 2 ** attempt);
      }
    }
  }

  private async transferWithRetry(
    assistantId: string,
    recordingId: string,
    operation: "begin" | "append" | "finish",
    chunk?: Uint8Array,
    sequence?: number,
    attachToConversationId?: string,
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
          attachToConversationId,
        );
      } catch (error) {
        if (isMissingRecordingState(error) || attempt === maxAttempts - 1) {
          throw error;
        }
        await this.dependencies.waitBeforeRetry(250 * 2 ** attempt);
      }
    }
    throw new Error("Recording transfer retry loop exhausted");
  }

  private async replayCompletedRecording(
    active: ActiveRecording,
    bridge: NonNullable<NonNullable<typeof window.vellum>["screenRecording"]>,
  ): Promise<{ attachmentId?: string }> {
    await this.transferWithRetry(
      active.assistantId,
      active.event.recordingId,
      "begin",
      undefined,
      undefined,
      active.event.attachToConversationId,
    );
    const maxBytes = 4 * 1024 * 1024;
    let offset = 0;
    let sequence = 0;
    while (true) {
      const { data, eof } = await bridge.read(
        active.event.recordingId,
        offset,
        maxBytes,
      );
      if (data.byteLength > 0) {
        await this.transferWithRetry(
          active.assistantId,
          active.event.recordingId,
          "append",
          data,
          sequence,
        );
        offset += data.byteLength;
        sequence += 1;
      }
      if (eof) {
        break;
      }
    }
    return this.transferWithRetry(
      active.assistantId,
      active.event.recordingId,
      "finish",
    );
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

  private keepAliveAfterServerRestart(recordingId: string): void {
    const active = this.active;
    if (!active || active.event.recordingId !== recordingId) {
      return;
    }
    active.restartRecovery = true;
    active.stopClaimMaintenance();
  }

  private async stop(recordingId: string, assistantId: string): Promise<void> {
    if (await this.cancelQueuedStart(recordingId, assistantId)) {
      return;
    }
    if (
      this.pending?.assistantId === assistantId &&
      this.pending.recordingId === recordingId
    ) {
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
    this.drainQueuedStarts();
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

export const handleScreenRecordingAssistantChange = (
  assistantId: string | null,
): Promise<void> => controller.handleAssistantChange(assistantId);

export const handleScreenRecordingLifecycleUnmount = (): Promise<void> =>
  controller.handleLifecycleOwnerUnmount();
