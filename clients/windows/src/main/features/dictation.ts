import { BrowserWindow, app, ipcMain, type WebContents } from "electron";
import path from "node:path";
import { z } from "zod";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  HELPER_DICTATION_PARTIAL_EVENT,
  HELPER_DICTATION_SET_PARTIALS,
  HELPER_GET_STATE,
  HELPER_PING,
  HELPER_RESTART,
  HELPER_STATE_EVENT,
  type DictationPartialsResult,
  type HelperRestartResult,
} from "@vellumai/ipc-contract";
import {
  NativeSidecarClient,
  type NativeSidecarState,
} from "@vellumai/native-sidecar/supervisor";

import { handle, on } from "../ipc.client";
import log from "../logger";

/**
 * Windows native helper bridge for dictation partials, served over the
 * same `vellum:helper:*` channels as the macOS shell. The renderer owns
 * the microphone and pushes 16 kHz mono Int16 PCM; the helper only runs
 * the recognizer, so no audio or transcript content is ever persisted.
 */

const HELPER_RESULT_SCHEMA = z.object({
  enabled: z.boolean(),
  reason: z.string().optional(),
  tap: z.string().optional(),
});
const DICTATION_TEXT_SCHEMA = z.object({ text: z.string() });
const DICTATION_PUSH_SAMPLE_RATE = 16000;

export const getWindowsHelperPath = (): string =>
  app.isPackaged
    ? path.join(
        process.resourcesPath,
        "native-helper",
        "Vellum.WindowsHelper.exe",
      )
    : path.join(
        app.getAppPath(),
        "resources",
        "native-helper",
        process.arch === "arm64" ? "arm64" : "x64",
        "Vellum.WindowsHelper.exe",
      );

let clientFactory = (): NativeSidecarClient =>
  new NativeSidecarClient({
    name: "windows helper",
    resolveExecutablePath: getWindowsHelperPath,
    logger: log,
    platform: process.platform,
  });
let client: NativeSidecarClient | null = null;
const getClient = (): NativeSidecarClient => (client ??= clientFactory());

let installed = false;
// The renderer that most recently enabled partials; live transcription
// events route only there. `finalOwner` survives the disable so the
// post-stop finalized transcript still reaches its window.
let partialsOwner: WebContents | null = null;
let finalOwner: WebContents | null = null;

const liveTarget = (target: WebContents | null): WebContents | null =>
  target && !target.isDestroyed() ? target : null;

const dictationTarget = (): WebContents | null =>
  liveTarget(partialsOwner) ?? liveTarget(finalOwner);

const setDictationPartials = async (
  sender: WebContents,
  enable: boolean,
  deviceName?: string,
  pushAudio?: boolean,
): Promise<DictationPartialsResult> => {
  try {
    const result = HELPER_RESULT_SCHEMA.safeParse(
      await getClient().call("dictation.setPartials", {
        enable,
        ...(deviceName ? { deviceName } : {}),
        ...(pushAudio
          ? { pushAudio: true, sampleRate: DICTATION_PUSH_SAMPLE_RATE }
          : {}),
      }),
    );
    if (!result.success) {
      return { ok: false, reason: "windows helper returned an invalid result" };
    }
    if (enable && !result.data.enabled) {
      return { ok: false, reason: result.data.reason ?? "unavailable" };
    }
    partialsOwner = enable ? sender : null;
    finalOwner = sender;
    return { ok: true, enabled: result.data.enabled };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};

const toAudioBuffer = (chunk: unknown): Buffer | null => {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(chunk));
  }
  return null;
};

const handleHelperState = (state: NativeSidecarState): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(HELPER_STATE_EVENT, state);
    }
  }
  if (state.status !== "running") {
    // The partials session died with the helper; the renderer's recording
    // simply continues without live text.
    partialsOwner = null;
    finalOwner = null;
  }
};

export const installDictation = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  const helper = getClient();

  helper.onNotification("dictation.partial", DICTATION_TEXT_SCHEMA, (event) => {
    dictationTarget()?.send(HELPER_DICTATION_PARTIAL_EVENT, event);
  });
  helper.onNotification(
    "dictation.finalized",
    DICTATION_TEXT_SCHEMA,
    (event) => {
      // Length only; transcript content must never be logged.
      log.info(`[win-helper] dictation finalized chars=${event.text.length}`);
      dictationTarget()?.send("vellum:helper:dictation:finalized", event);
    },
  );
  helper.onNotification(
    "dictation.error",
    z.object({ message: z.string() }),
    (event) => {
      log.warn(`[win-helper] dictation error: ${event.message}`);
    },
  );
  helper.onState(handleHelperState);

  handle(
    HELPER_PING,
    z.tuple([]),
    () => getClient().call("ping") as Promise<"pong">,
  );
  handle(HELPER_GET_STATE, z.tuple([]), () => getClient().getState());
  handle(HELPER_RESTART, z.tuple([]), (): HelperRestartResult => {
    try {
      return { ok: true, state: getClient().retry() };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        state: getClient().getState(),
      };
    }
  });
  handle(
    HELPER_DICTATION_SET_PARTIALS,
    z.tuple([z.boolean(), z.string().optional(), z.boolean().optional()]),
    ([enable, deviceName, pushAudio], event) =>
      setDictationPartials(event.sender, enable, deviceName, pushAudio),
  );
  // High-frequency fire-and-forget PCM from the partials owner, on the
  // origin-validated registrar (no invoke round-trip per ~100ms chunk).
  on(
    "vellum:helper:dictation:audio",
    z.tuple([z.unknown()]),
    ([chunk], event) => {
      if (event.sender !== partialsOwner) {
        return;
      }
      const buf = toAudioBuffer(chunk);
      if (!buf || buf.length === 0) {
        return;
      }
      void getClient()
        .call("dictation.appendAudio", { audio: buf.toString("base64") })
        .catch(() => {
          // Helper restarting mid-session; chunks are best-effort.
        });
    },
  );

  app.on("before-quit", () => {
    getClient().shutdown({
      method: "dictation.setPartials",
      params: { enable: false },
    });
  });
};

const dictation: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "dictation",
  install: installDictation,
};

export default dictation;

export const __resetForTesting = (
  factory?: () => NativeSidecarClient,
): void => {
  installed = false;
  ipcMain.removeAllListeners("vellum:helper:dictation:audio");
  partialsOwner = null;
  finalOwner = null;
  client = null;
  if (factory) {
    clientFactory = factory;
  }
};
