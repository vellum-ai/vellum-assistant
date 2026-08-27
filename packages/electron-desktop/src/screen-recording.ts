import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { desktopCapturer, session } from "electron";
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
  recordingId: string;
  filePath: string;
  file: FileHandle;
  write: Promise<void>;
}

export interface InstallScreenRecordingOptions {
  appDataDir: string;
  handle: IpcHandle;
}

export const resolveScreenRecordingDirectory = (appDataDir: string): string =>
  path.join(appDataDir, "vellum-assistant", "recordings");

export const installScreenRecording = ({
  appDataDir,
  handle,
}: InstallScreenRecordingOptions): void => {
  let active: RecordingFileSession | null = null;
  const recordingsDir = resolveScreenRecordingDirectory(appDataDir);

  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const [source] = await desktopCapturer.getSources({
        types: ["screen", "window"],
        fetchWindowIcons: false,
        thumbnailSize: { width: 0, height: 0 },
      });
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

  handle(
    SCREEN_RECORDING_BEGIN,
    z.tuple([RecordingIdSchema]),
    async ([recordingId]) => {
      if (active) {
        throw new Error("A screen recording is already active");
      }
      await mkdir(recordingsDir, { recursive: true });
      const filePath = path.join(
        recordingsDir,
        `screen-recording-${recordingId}.webm`,
      );
      const file = await open(filePath, "w");
      active = {
        recordingId,
        filePath,
        file,
        write: Promise.resolve(),
      };
    },
  );

  handle(
    SCREEN_RECORDING_APPEND,
    z.tuple([RecordingIdSchema, RecordingChunkSchema]),
    async ([recordingId, chunk]) => {
      if (!active || active.recordingId !== recordingId) {
        throw new Error("Screen recording session not found");
      }
      const recording = active;
      recording.write = recording.write.then(async () => {
        await recording.file.write(chunk);
      });
      await recording.write;
    },
  );

  handle(
    SCREEN_RECORDING_FINISH,
    z.tuple([RecordingIdSchema]),
    async ([recordingId]) => {
      if (!active || active.recordingId !== recordingId) {
        throw new Error("Screen recording session not found");
      }
      await active.write;
      await active.file.close();
      const { filePath } = active;
      active = null;
      return { filePath };
    },
  );

  handle(
    SCREEN_RECORDING_ABORT,
    z.tuple([RecordingIdSchema]),
    async ([recordingId]) => {
      if (!active || active.recordingId !== recordingId) {
        return;
      }
      const aborted = active;
      active = null;
      await aborted.write.catch(() => undefined);
      await aborted.file.close();
      await rm(aborted.filePath, { force: true });
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
      return sources[0]?.id ?? null;
    },
  );
};
