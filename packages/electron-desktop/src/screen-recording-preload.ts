import type { IpcRenderer } from "electron";

import {
  SCREEN_RECORDING_ABORT,
  SCREEN_RECORDING_APPEND,
  SCREEN_RECORDING_BEGIN,
  SCREEN_RECORDING_FINISH,
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
  finish: (recordingId, options) =>
    ipcRenderer.invoke(
      SCREEN_RECORDING_FINISH,
      recordingId,
      options?.includeBytes ?? false,
    ) as Promise<{
      filePath: string;
      bytes?: Uint8Array;
    }>,
  abort: (recordingId) =>
    ipcRenderer.invoke(SCREEN_RECORDING_ABORT, recordingId) as Promise<void>,
  resolveSource: (options) =>
    ipcRenderer.invoke(SCREEN_RECORDING_RESOLVE_SOURCE, options) as Promise<
      string | null
    >,
});
