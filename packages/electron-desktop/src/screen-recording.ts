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
  const sessions = new Map<string, RecordingFileSession>();
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
      if (sessions.size > 0) {
        throw new Error("A screen recording is already active");
      }
      await mkdir(recordingsDir, { recursive: true });
      const filePath = path.join(
        recordingsDir,
        `screen-recording-${recordingId}.webm`,
      );
      const file = await open(filePath, "w");
      sessions.set(recordingId, { filePath, file, write: Promise.resolve() });
    },
  );

  handle(
    SCREEN_RECORDING_APPEND,
    z.tuple([RecordingIdSchema, RecordingChunkSchema]),
    async ([recordingId, chunk]) => {
      const session = sessions.get(recordingId);
      if (!session) {
        throw new Error("Screen recording session not found");
      }
      session.write = session.write.then(async () => {
        await session.file.write(chunk);
      });
      await session.write;
    },
  );

  handle(
    SCREEN_RECORDING_FINISH,
    z.tuple([RecordingIdSchema]),
    async ([recordingId]) => {
      const session = sessions.get(recordingId);
      if (!session) {
        throw new Error("Screen recording session not found");
      }
      await session.write;
      await session.file.close();
      sessions.delete(recordingId);
      return { filePath: session.filePath };
    },
  );

  handle(
    SCREEN_RECORDING_ABORT,
    z.tuple([RecordingIdSchema]),
    async ([recordingId]) => {
      const session = sessions.get(recordingId);
      if (!session) {
        return;
      }
      sessions.delete(recordingId);
      await session.write.catch(() => undefined);
      await session.file.close();
      await rm(session.filePath, { force: true });
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
