import type {
  RecordingPauseEvent,
  RecordingResumeEvent,
  RecordingStartEvent,
  RecordingStopEvent,
} from "@vellumai/assistant-api";

import { recordingsStatusPost } from "@/generated/daemon/sdk.gen";
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

interface ActiveRecording {
  event: RecordingStartEvent;
  recorder: MediaRecorder;
  startedAt: number;
  stopped: Promise<void>;
  closeCapture: () => void;
}

interface CapturedMedia {
  stream: MediaStream;
  close: () => void;
}

const postStatus = async (
  event: RecordingStartEvent,
  status: RecordingStatus,
  details: { filePath?: string; durationMs?: number; error?: string } = {},
): Promise<void> => {
  const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
  if (!assistantId) {
    throw new Error("No active assistant for screen recording status");
  }
  const { response } = await recordingsStatusPost({
    path: { assistant_id: assistantId },
    body: {
      conversationId: event.recordingId,
      status,
      attachToConversationId: event.attachToConversationId,
      operationToken: event.operationToken,
      ...details,
    },
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

const captureSelectedSource = async (
  event: RecordingStartEvent,
): Promise<MediaStream> => {
  const options = event.options ?? {};
  const hasSelectedSource =
    options.displayId !== undefined || options.windowId !== undefined;
  const promptForSource = options.promptForSource ?? !hasSelectedSource;

  if (promptForSource) {
    return navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: options.includeAudio ?? false,
    });
  }

  const sourceId = await window.vellum!.screenRecording!.resolveSource({
    captureScope: options.captureScope,
    displayId: options.displayId,
    windowId: options.windowId,
  });
  if (!sourceId) {
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
          ...destination.stream.getTracks(),
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

export class ScreenRecordingController {
  private active: ActiveRecording | null = null;

  constructor(
    private readonly dependencies: {
      capture: typeof captureStream;
      chooseMimeType: typeof recorderMimeType;
      createRecorder: (stream: MediaStream, mimeType: string) => MediaRecorder;
      now: () => number;
      reportStatus: typeof postStatus;
    } = {
      capture: captureStream,
      chooseMimeType: recorderMimeType,
      createRecorder: (stream, mimeType) =>
        new MediaRecorder(stream, { mimeType }),
      now: Date.now,
      reportStatus: postStatus,
    },
  ) {}

  async handle(event: RecordingLifecycleEvent): Promise<void> {
    if (!window.vellum?.screenRecording) {
      return;
    }
    switch (event.type) {
      case "recording_start":
        await this.start(event);
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

  private async start(event: RecordingStartEvent): Promise<void> {
    const bridge = window.vellum!.screenRecording!;
    if (this.active) {
      await this.dependencies.reportStatus(event, "failed", {
        error: "A screen recording is already active",
      });
      return;
    }

    let capture: CapturedMedia | null = null;
    let recorder: MediaRecorder | null = null;
    let fileStarted = false;
    try {
      const mimeType = this.dependencies.chooseMimeType();
      if (!mimeType) {
        throw new Error("This desktop cannot encode a screen recording");
      }
      capture = await this.dependencies.capture(event);
      await bridge.begin(event.recordingId);
      fileStarted = true;

      recorder = this.dependencies.createRecorder(capture.stream, mimeType);
      let writes = Promise.resolve();
      recorder.ondataavailable = (dataEvent) => {
        if (dataEvent.data.size === 0) {
          return;
        }
        writes = writes.then(async () => {
          const bytes = new Uint8Array(await dataEvent.data.arrayBuffer());
          await bridge.append(event.recordingId, bytes);
        });
      };

      let resolveStopped!: () => void;
      let rejectStopped!: (error: unknown) => void;
      const stopped = new Promise<void>((resolve, reject) => {
        resolveStopped = resolve;
        rejectStopped = reject;
      });
      const active: ActiveRecording = {
        event,
        recorder,
        startedAt: this.dependencies.now(),
        stopped,
        closeCapture: capture.close,
      };
      recorder.onstop = () => {
        void (async () => {
          try {
            await writes;
            const { filePath } = await bridge.finish(event.recordingId);
            await this.dependencies.reportStatus(event, "stopped", {
              filePath,
              durationMs: this.dependencies.now() - active.startedAt,
            });
            resolveStopped();
          } catch (error) {
            await bridge.abort(event.recordingId);
            await this.dependencies
              .reportStatus(event, "failed", {
                error: error instanceof Error ? error.message : String(error),
              })
              .catch(() => undefined);
            rejectStopped(error);
          } finally {
            active.closeCapture();
            if (this.active === active) {
              this.active = null;
            }
          }
        })();
      };
      this.active = active;
      for (const track of capture.stream.getVideoTracks()) {
        track.addEventListener("ended", () => {
          void this.stop(event.recordingId);
        });
      }
      recorder.start(1_000);
      await this.dependencies.reportStatus(event, "started");
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
      await this.dependencies.reportStatus(
        event,
        event.operationToken && isPickerCancellation(error)
          ? "restart_cancelled"
          : "failed",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async stop(recordingId: string): Promise<void> {
    const active = this.active;
    if (!active || active.event.recordingId !== recordingId) {
      return;
    }
    if (active.recorder.state !== "inactive") {
      active.recorder.stop();
    }
    await active.stopped;
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
    await this.dependencies.reportStatus(active.event, "paused");
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
    await this.dependencies.reportStatus(active.event, "resumed");
  }
}

const controller = new ScreenRecordingController();

export const handleScreenRecordingEvent = (
  event: RecordingLifecycleEvent,
): Promise<void> => controller.handle(event);
