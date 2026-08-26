import type { IpcRenderer } from "electron";

import {
  SCREEN_RECORDING_ABORT,
  SCREEN_RECORDING_APPEND,
  SCREEN_RECORDING_BEGIN,
  SCREEN_RECORDING_FINISH,
  SCREEN_RECORDING_READ,
  SCREEN_RECORDING_RELEASE,
  SCREEN_RECORDING_RESOLVE_SOURCE,
  type VellumBridge,
} from "@vellumai/ipc-contract";

export const createScreenRecordingPreloadBridge = (
  ipcRenderer: Pick<IpcRenderer, "invoke">,
): VellumBridge["screenRecording"] => ({
  begin: (recordingId) =>
    ipcRenderer.invoke(SCREEN_RECORDING_BEGIN, recordingId) as Promise<void>,
  append: (recordingId, chunk) =>
    ipcRenderer.invoke(
      SCREEN_RECORDING_APPEND,
      recordingId,
      chunk,
    ) as Promise<void>,
  finish: (recordingId) =>
    ipcRenderer.invoke(SCREEN_RECORDING_FINISH, recordingId) as Promise<{
      filePath: string;
    }>,
  abort: (recordingId) =>
    ipcRenderer.invoke(SCREEN_RECORDING_ABORT, recordingId) as Promise<void>,
  read: (recordingId, offset, maxBytes) =>
    ipcRenderer.invoke(
      SCREEN_RECORDING_READ,
      recordingId,
      offset,
      maxBytes,
    ) as Promise<{ data: Uint8Array; eof: boolean }>,
  release: (recordingId) =>
    ipcRenderer.invoke(SCREEN_RECORDING_RELEASE, recordingId) as Promise<void>,
  resolveSource: (options) =>
    ipcRenderer.invoke(SCREEN_RECORDING_RESOLVE_SOURCE, options) as Promise<
      string | null
    >,
});
