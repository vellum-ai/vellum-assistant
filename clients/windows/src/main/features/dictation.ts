import { BrowserWindow, app, type WebContents } from "electron";
import { z } from "zod";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  DICTATION_PUSH_SAMPLE_RATE,
  dictationPartialsHelperResultSchema,
  DictationOwnerRouter,
  requestDictationTranscription,
  toAudioBuffer,
} from "@vellumai/electron-desktop/dictation-routing";
import {
  HELPER_DICTATION_FINALIZED_EVENT,
  HELPER_DICTATION_PARTIAL_EVENT,
  HELPER_DICTATION_SET_PARTIALS,
  HELPER_DICTATION_TRANSCRIBE,
  HELPER_DICTATION_TRANSCRIBED_EVENT,
  HELPER_GET_STATE,
  HELPER_PING,
  HELPER_RESTART,
  HELPER_STATE_EVENT,
  type DictationPartialsResult,
  type HelperRestartResult,
} from "@vellumai/ipc-contract";
import {
  type NativeSidecarClient,
  type NativeSidecarState,
} from "@vellumai/native-sidecar/supervisor";

import { handle, on } from "../ipc.client";
import log from "../logger";
import { getWindowsHelperClient } from "../windows-helper";

/**
 * Windows native helper bridge for dictation partials, served over the
 * same `vellum:helper:*` channels as the macOS shell. The renderer owns
 * the microphone and pushes 16 kHz mono Int16 PCM; the helper only runs
 * the recognizer, so no audio or transcript content is ever persisted.
 */

const DICTATION_TEXT_SCHEMA = z.object({ text: z.string() });
const DICTATION_TRANSCRIBED_SCHEMA = DICTATION_TEXT_SCHEMA.extend({
  requestId: z.string(),
});
let clientFactory = (): NativeSidecarClient => getWindowsHelperClient();
let client: NativeSidecarClient | null = null;
const getClient = (): NativeSidecarClient => (client ??= clientFactory());

let installed = false;
const dictationOwners = new DictationOwnerRouter();
let dictationPartialsQueue: Promise<void> = Promise.resolve();
let transcriptionRequestSequence = 0;

const applyDictationPartials = async (
  sender: WebContents,
  enable: boolean,
  deviceName?: string,
  pushAudio?: boolean,
): Promise<DictationPartialsResult> => {
  if (!enable && !dictationOwners.ownsPartials(sender)) {
    return { ok: true, enabled: false };
  }
  try {
    const result = dictationPartialsHelperResultSchema.safeParse(
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
    const previousOwner = dictationOwners.setOwner(sender, enable);
    if (
      enable &&
      previousOwner &&
      previousOwner !== sender &&
      !previousOwner.isDestroyed()
    ) {
      previousOwner.send(HELPER_DICTATION_FINALIZED_EVENT, { text: "" });
    }
    return { ok: true, enabled: result.data.enabled };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};

const setDictationPartials = (
  sender: WebContents,
  enable: boolean,
  deviceName?: string,
  pushAudio?: boolean,
): Promise<DictationPartialsResult> => {
  const operation = dictationPartialsQueue.then(() =>
    applyDictationPartials(sender, enable, deviceName, pushAudio),
  );
  dictationPartialsQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
};

const handleHelperState = (state: NativeSidecarState): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(HELPER_STATE_EVENT, state);
    }
  }
  if (state.status !== "running") {
    dictationOwners
      .target()
      ?.send(HELPER_DICTATION_FINALIZED_EVENT, { text: "" });
    dictationOwners
      .transcriptionTarget()
      ?.send(HELPER_DICTATION_TRANSCRIBED_EVENT, { text: "" });
    dictationOwners.clear();
  }
};

export const installDictation = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  const helper = getClient();

  helper.onNotification("dictation.partial", DICTATION_TEXT_SCHEMA, (event) => {
    dictationOwners.target()?.send(HELPER_DICTATION_PARTIAL_EVENT, event);
  });
  helper.onNotification(
    "dictation.finalized",
    DICTATION_TEXT_SCHEMA,
    (event) => {
      // Length only; transcript content must never be logged.
      log.info(`[win-helper] dictation finalized chars=${event.text.length}`);
      dictationOwners
        .target()
        ?.send(HELPER_DICTATION_FINALIZED_EVENT, event);
    },
  );
  helper.onNotification(
    "dictation.transcribed",
    DICTATION_TRANSCRIBED_SCHEMA,
    (event) => {
      const owner = dictationOwners.takeTranscriptionTarget(event.requestId);
      owner?.send(HELPER_DICTATION_TRANSCRIBED_EVENT, { text: event.text });
    },
  );
  helper.onNotification(
    "dictation.error",
    z.object({ message: z.string() }),
    (event) => {
      log.warn(`[win-helper] dictation error: ${event.message}`);
      dictationOwners
        .target()
        ?.send(HELPER_DICTATION_FINALIZED_EVENT, { text: "" });
      dictationOwners.clearStreaming();
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
  handle(
    HELPER_DICTATION_TRANSCRIBE,
    z.tuple([z.unknown()]),
    ([audio], event) => {
      const requestId = String(++transcriptionRequestSequence);
      return requestDictationTranscription({
        audio,
        sender: event.sender,
        owners: dictationOwners,
        client: getClient(),
        requestId,
        onOwnerReplaced: (owner) => {
          owner.send(HELPER_DICTATION_TRANSCRIBED_EVENT, { text: "" });
        },
      });
    },
  );
  // Fire-and-forget PCM from the partials owner (no per-chunk round-trip).
  on(
    "vellum:helper:dictation:audio",
    z.tuple([z.unknown()]),
    ([chunk], event) => {
      if (!dictationOwners.ownsPartials(event.sender)) {
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
  dictationOwners.clear();
  dictationPartialsQueue = Promise.resolve();
  transcriptionRequestSequence = 0;
  client = null;
  clientFactory = factory ?? getWindowsHelperClient;
};
