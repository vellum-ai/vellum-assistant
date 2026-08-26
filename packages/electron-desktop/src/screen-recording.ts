import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  app,
  desktopCapturer,
  dialog,
  session,
  type DesktopCapturerSource,
  type WebContents,
} from "electron";
import { z } from "zod";

import {
  SCREEN_RECORDING_ABORT,
  SCREEN_RECORDING_APPEND,
  SCREEN_RECORDING_BEGIN,
  SCREEN_RECORDING_FINISH,
  SCREEN_RECORDING_RESOLVE_SOURCE,
} from "@vellumai/ipc-contract";
import type { IpcHandle } from "./ipc";

const RecordingIdSchema = z.string().uuid();
const RecordingChunkSchema = z.instanceof(Uint8Array);
const RecordingSourceOptionsSchema = z.object({
  captureScope: z.enum(["display", "window"]).optional(),
  displayId: z.string().optional(),
  windowId: z.number().int().nonnegative().optional(),
});

interface RecordingFileSession {
  filePath: string;
  file: FileHandle;
  write: Promise<void>;
  owner: WebContents;
  onOwnerDestroyed: () => void;
}

export interface InstallScreenRecordingOptions {
  appDataDir: string;
  handle: IpcHandle;
}

export const resolveScreenRecordingDirectory = (appDataDir: string): string =>
  path.join(appDataDir, "vellum-assistant", "recordings");

const chooseCaptureSource = async (): Promise<DesktopCapturerSource | null> => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    fetchWindowIcons: false,
    thumbnailSize: { width: 0, height: 0 },
  });
  if (sources.length === 0) {
    return null;
  }
  const cancelId = sources.length;
  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "Choose what to record",
    message: "Choose a screen or window to record",
    buttons: [
      ...sources.map((source) => {
        const type = source.id.startsWith("screen:") ? "Display" : "Window";
        return `${type}: ${source.name || "Untitled"}`;
      }),
      "Cancel",
    ],
    cancelId,
    defaultId: 0,
    noLink: true,
    normalizeAccessKeys: true,
  });
  return response === cancelId ? null : (sources[response] ?? null);
};

export const installScreenRecording = ({
  appDataDir,
  handle,
}: InstallScreenRecordingOptions): void => {
  const sessions = new Map<string, RecordingFileSession>();
  const recordingsDir = resolveScreenRecordingDirectory(appDataDir);

  const releaseSession = (
    recordingId: string,
    recording: RecordingFileSession,
  ): void => {
    sessions.delete(recordingId);
    recording.owner.removeListener("destroyed", recording.onOwnerDestroyed);
  };

  const abortSession = async (recordingId: string): Promise<void> => {
    const recording = sessions.get(recordingId);
    if (!recording) {
      return;
    }
    releaseSession(recordingId, recording);
    await recording.write.catch(() => undefined);
    await recording.file.close().catch(() => undefined);
    await rm(recording.filePath, { force: true });
  };

  const getOwnedSession = (
    recordingId: string,
    owner: WebContents,
  ): RecordingFileSession => {
    const recording = sessions.get(recordingId);
    if (!recording) {
      throw new Error("Screen recording session not found");
    }
    if (recording.owner !== owner) {
      throw new Error("Screen recording session belongs to another window");
    }
    return recording;
  };

  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const source = await chooseCaptureSource().catch(() => null);
      if (!source) {
        callback({});
        return;
      }
      callback({
        video: source,
        ...(request.audioRequested && process.platform === "win32"
          ? { audio: "loopback" as const }
          : {}),
      });
    },
    { useSystemPicker: true },
  );

  app.once("before-quit", () => {
    for (const recordingId of [...sessions.keys()]) {
      void abortSession(recordingId).catch(() => undefined);
    }
  });

  handle(
    SCREEN_RECORDING_BEGIN,
    z.tuple([RecordingIdSchema]),
    async ([recordingId], event) => {
      if (sessions.size > 0) {
        throw new Error("A screen recording is already active");
      }
      await mkdir(recordingsDir, { recursive: true });
      const filePath = path.join(
        recordingsDir,
        `screen-recording-${recordingId}.webm`,
      );
      const file = await open(filePath, "w");
      const onOwnerDestroyed = (): void => {
        void abortSession(recordingId).catch(() => undefined);
      };
      sessions.set(recordingId, {
        filePath,
        file,
        write: Promise.resolve(),
        owner: event.sender,
        onOwnerDestroyed,
      });
      event.sender.once("destroyed", onOwnerDestroyed);
    },
  );

  handle(
    SCREEN_RECORDING_APPEND,
    z.tuple([RecordingIdSchema, RecordingChunkSchema]),
    async ([recordingId, chunk], event) => {
      const recording = getOwnedSession(recordingId, event.sender);
      recording.write = recording.write.then(async () => {
        await recording.file.write(chunk);
      });
      await recording.write;
    },
  );

  handle(
    SCREEN_RECORDING_FINISH,
    z.tuple([RecordingIdSchema]),
    async ([recordingId], event) => {
      const recording = getOwnedSession(recordingId, event.sender);
      releaseSession(recordingId, recording);
      await recording.write;
      await recording.file.close();
      return { filePath: recording.filePath };
    },
  );

  handle(
    SCREEN_RECORDING_ABORT,
    z.tuple([RecordingIdSchema]),
    async ([recordingId], event) => {
      const recording = sessions.get(recordingId);
      if (!recording) {
        return;
      }
      getOwnedSession(recordingId, event.sender);
      await abortSession(recordingId);
    },
  );

  handle(
    SCREEN_RECORDING_RESOLVE_SOURCE,
    z.tuple([RecordingSourceOptionsSchema]),
    async ([options]) => {
      const types: Array<"screen" | "window"> =
        options.captureScope === "window" ? ["window"] : ["screen"];
      const sources = await desktopCapturer.getSources({
        types,
        fetchWindowIcons: false,
        thumbnailSize: { width: 0, height: 0 },
      });
      if (options.displayId) {
        return (
          sources.find((source) => source.display_id === options.displayId)
            ?.id ?? null
        );
      }
      if (options.windowId !== undefined) {
        const prefix = `window:${options.windowId}:`;
        return (
          sources.find((source) => source.id.startsWith(prefix))?.id ?? null
        );
      }
      return null;
    },
  );
};
