import { BrowserWindow, app, ipcMain, type WebContents } from "electron";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import type {
  DictationPartialEvent,
  DictationPartialsResult,
  FnPushToTalkResult,
  HelperRestartResult,
  HelperState,
  HotkeyEvent,
  HotkeyEventState,
} from "@vellumai/ipc-contract";

import { handle } from "./ipc";
import log from "./logger";
import {
  MacHelperClient,
  type MacHelperClientOptions,
  type MacHelperState,
} from "./sidecar/mac-helper";
import {
  getMacHelperAppPath,
  getMacHelperPath,
} from "./sidecar/mac-helper-path";

export type {
  DictationPartialEvent,
  DictationPartialsResult,
  FnPushToTalkResult,
  HelperRestartResult,
  HelperState,
  HotkeyEvent,
  HotkeyEventState,
};

export type MacHelperPermissionKind =
  | "speechRecognition"
  | "inputMonitoring";

export type MacHelperPermissionStatus =
  | "unknown"
  | "restricted"
  | "denied"
  | "not-determined"
  | "granted";

const HOTKEY_EVENT_SCHEMA = z.object({
  kind: z.literal("fnPushToTalk"),
  state: z.enum(["down", "up"]),
});

const HOTKEY_RESULT_SCHEMA = z.object({
  enabled: z.boolean(),
});

const HELPER_PERMISSION_STATUS_SCHEMA = z.object({
  status: z.enum([
    "unknown",
    "restricted",
    "denied",
    "not-determined",
    "granted",
  ]),
});

const DICTATION_PARTIAL_SCHEMA = z.object({
  text: z.string(),
});

const DICTATION_ERROR_SCHEMA = z.object({
  message: z.string(),
  onDevice: z.boolean(),
  willRetryServer: z.boolean(),
});

const DICTATION_TRANSCRIBE_RESULT_SCHEMA = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
});

const DICTATION_RESULT_SCHEMA = z.object({
  enabled: z.boolean(),
  reason: z.string().optional(),
  // Which input device the helper's recognizer tap actually captures.
  tap: z.string().optional(),
});

let platformForTesting: NodeJS.Platform | null = null;
let supervisorOptionsForTesting: Partial<
  Pick<
    MacHelperClientOptions,
    | "initialBackoffMs"
    | "maxBackoffMs"
    | "stableResetMs"
    | "circuitCrashCount"
    | "circuitWindowMs"
  >
> = {};

const getPlatform = (): NodeJS.Platform =>
  platformForTesting ?? process.platform;

const makeClient = (): MacHelperClient =>
  new MacHelperClient({
    name: "mac helper",
    resolveExecutablePath: getMacHelperPath,
    logger: log,
    platform: getPlatform(),
    ...supervisorOptionsForTesting,
  });

let client = makeClient();

const fnPushToTalk = async (
  enable: boolean,
): Promise<FnPushToTalkResult> => {
  try {
    const result = await client.call("hotkey.fnPushToTalk", { enable });
    const parsed = HOTKEY_RESULT_SCHEMA.safeParse(result);
    if (!parsed.success) {
      return { ok: false, reason: "mac helper returned invalid hotkey result" };
    }
    return { ok: true, enabled: parsed.data.enabled };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};

const ping = async (): Promise<"pong"> => {
  const result = await client.call("ping");
  if (result !== "pong") {
    throw new Error("mac helper returned invalid ping result");
  }
  return "pong";
};

export const queryMacHelperPermission = async (
  kind: MacHelperPermissionKind,
): Promise<MacHelperPermissionStatus> => {
  const result = await client.call("permission.status", { kind });
  return HELPER_PERMISSION_STATUS_SCHEMA.parse(result).status;
};

export const queryFreshMacHelperPermission = async (
  kind: MacHelperPermissionKind,
): Promise<MacHelperPermissionStatus> => {
  const result = await queryBundledMacHelperPermission(kind);
  return HELPER_PERMISSION_STATUS_SCHEMA.parse(result).status;
};

export const requestMacHelperSpeechRecognitionPermission =
  async (): Promise<void> => {
    await openMacHelperApp(["--request-speech-recognition"]);
  };

export const requestMacHelperInputMonitoringPermission =
  async (): Promise<void> => {
    await openMacHelperApp(["--request-input-monitoring"]);
  };

const queryBundledMacHelperPermission = async (
  kind: MacHelperPermissionKind,
): Promise<unknown> => {
  const tempDir = await mkdtemp(
    path.join(tmpdir(), "vellum-mac-helper-permission-"),
  );
  const outputPath = path.join(tempDir, "status.json");

  try {
    await openMacHelperApp(
      [
        "--permission-status",
        kind,
        "--status-output",
        outputPath,
      ],
    );
    return await readPermissionStatusFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

const openMacHelperApp = async (
  helperArgs: string[],
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-n",
      getMacHelperAppPath(),
      "--args",
      ...helperArgs,
    ];
    const child = spawn("open", args, { stdio: "ignore" });
    let settled = false;

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    child.once("error", settle);
    child.once("exit", (code) => {
      if (code === 0) {
        settle();
      } else {
        settle(new Error(`open exited with code ${code ?? "unknown"}`));
      }
    });
  });
};

const readPermissionStatusFile = async (
  outputPath: string,
): Promise<unknown> => {
  const deadline = Date.now() + 5_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(outputPath, "utf8"));
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("mac helper permission status did not appear");
};

interface HotkeyOwner {
  webContents: WebContents;
  cleanup: () => void;
}

// The renderer that most recently enabled dictation partials — the recording
// session's host. Partial notifications route only there.
let dictationPartialsOwner: WebContents | null = null;

// The renderer's push pipeline downsamples to 16 kHz mono Int16 (the
// pcm-downsample worklet contract).
const DICTATION_PUSH_SAMPLE_RATE = 16000;

const setDictationPartials = async (
  webContents: WebContents,
  enable: boolean,
  deviceName?: string,
  pushAudio?: boolean,
): Promise<DictationPartialsResult> => {
  try {
    const result = await client.call("dictation.setPartials", {
      enable,
      ...(deviceName ? { deviceName } : {}),
      ...(pushAudio
        ? { pushAudio: true, sampleRate: DICTATION_PUSH_SAMPLE_RATE }
        : {}),
    });
    const parsed = DICTATION_RESULT_SCHEMA.safeParse(result);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "mac helper returned invalid dictation result",
      };
    }
    if (enable && !parsed.data.enabled) {
      log.warn(
        `[mac-helper] dictation partials enable refused (wc=${webContents.id}): ${parsed.data.reason ?? "unavailable"}`,
      );
      return { ok: false, reason: parsed.data.reason ?? "unavailable" };
    }
    const previousOwner = dictationPartialsOwner;
    dictationPartialsOwner = enable ? webContents : null;
    // The finalized transcript (and the final partial flush) arrive AFTER
    // disable — keep routing to the window that just stopped recording.
    dictationFinalOwner = webContents;
    if (enable) {
      forwardedPartialCount = 0;
      audioChunkCount = 0;
    }
    const replaced =
      previousOwner && previousOwner !== webContents && !previousOwner.isDestroyed()
        ? ` (replaced wc=${previousOwner.id})`
        : "";
    const tap = enable && parsed.data.tap ? ` tap=${parsed.data.tap}` : "";
    log.info(
      `[mac-helper] dictation partials ${enable ? "enabled" : "disabled"} by wc=${webContents.id}${replaced}${tap}`,
    );
    return { ok: true, enabled: parsed.data.enabled };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};

let forwardedPartialCount = 0;
let audioChunkCount = 0;
// The window that should receive post-disable dictation events (the final
// partial flush and `dictation.finalized`) — survives the owner being
// nulled by the disable call.
let dictationFinalOwner: WebContents | null = null;

const toAudioBuffer = (chunk: unknown): Buffer | null => {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (chunk instanceof ArrayBuffer) return Buffer.from(new Uint8Array(chunk));
  return null;
};

const dictationEventTarget = (): WebContents | null => {
  if (dictationPartialsOwner && !dictationPartialsOwner.isDestroyed()) {
    return dictationPartialsOwner;
  }
  if (dictationFinalOwner && !dictationFinalOwner.isDestroyed()) {
    return dictationFinalOwner;
  }
  return null;
};

const sendDictationPartialToOwner = (event: DictationPartialEvent): void => {
  forwardedPartialCount += 1;
  const owner = dictationEventTarget();
  if (forwardedPartialCount === 1 || forwardedPartialCount % 25 === 0) {
    // Count/length only — transcript content must never be logged.
    log.info(
      `[mac-helper] dictation partial #${forwardedPartialCount} chars=${event.text.length} → ${owner ? `wc=${owner.id}` : "DROPPED (no owner)"}`,
    );
  }
  if (!owner) return;
  owner.send("vellum:helper:dictation:partial", event);
};

const sendDictationTextEventToOwner = (
  kind: "finalized" | "transcribed",
  event: DictationPartialEvent,
): void => {
  const owner = dictationEventTarget();
  // Length only — transcript content must never be logged.
  log.info(
    `[mac-helper] dictation ${kind} chars=${event.text.length} → ${owner ? `wc=${owner.id}` : "DROPPED (no owner)"}`,
  );
  if (!owner) return;
  owner.send(`vellum:helper:dictation:${kind}`, event);
};

const hotkeyOwners = new Map<number, HotkeyOwner>();
let activeHotkeyOwnerId: number | null = null;
let helperRegistered = false;
let helperRegistrationSync: Promise<FnPushToTalkResult> | null = null;
let restoreHotkeyAfterRestart = false;
let restoreHotkeyInFlight = false;
let pttIsDown = false;

const shouldRegisterHelper = (): boolean => hotkeyOwners.size > 0;

const newestOwnerId = (): number | null => {
  let id: number | null = null;
  for (const [ownerId, owner] of hotkeyOwners) {
    if (!owner.webContents.isDestroyed()) id = ownerId;
  }
  return id;
};

const removeHotkeyOwner = (webContentsId: number): void => {
  const owner = hotkeyOwners.get(webContentsId);
  if (!owner) return;
  owner.cleanup();
  hotkeyOwners.delete(webContentsId);
  if (activeHotkeyOwnerId === webContentsId) {
    activeHotkeyOwnerId = newestOwnerId();
  }
};

const disableFnPushToTalkForOwner = async (
  webContents: WebContents,
): Promise<FnPushToTalkResult> => {
  removeHotkeyOwner(webContents.id);

  if (hotkeyOwners.size === 0) restoreHotkeyAfterRestart = false;
  return syncFnPushToTalkRegistration();
};

const addHotkeyOwner = (webContents: WebContents): void => {
  const id = webContents.id;
  if (hotkeyOwners.has(id)) {
    activeHotkeyOwnerId = id;
    return;
  }

  const win = BrowserWindow.fromWebContents(webContents);
  const markActive = () => {
    if (hotkeyOwners.has(id)) activeHotkeyOwnerId = id;
  };
  const handleDestroyed = () => {
    void disableFnPushToTalkForOwner(webContents);
  };

  webContents.once("destroyed", handleDestroyed);
  win?.on("focus", markActive);

  hotkeyOwners.set(id, {
    webContents,
    cleanup: () => {
      webContents.off("destroyed", handleDestroyed);
      win?.off("focus", markActive);
    },
  });
  activeHotkeyOwnerId = id;
};

const enableFnPushToTalkForOwner = async (
  webContents: WebContents,
): Promise<FnPushToTalkResult> => {
  addHotkeyOwner(webContents);

  const result = await syncFnPushToTalkRegistration();
  if (!result.ok) {
    log.warn(
      `[mac-helper] failed to enable Fn push-to-talk: ${result.reason}`,
    );
    removeHotkeyOwner(webContents.id);
    void syncFnPushToTalkRegistration();
  }
  return result;
};

const setHelperRegistration = async (
  enable: boolean,
): Promise<FnPushToTalkResult> => {
  const result = await fnPushToTalk(enable);
  if (!result.ok) return result;

  helperRegistered = result.enabled;
  if (result.enabled !== enable) {
    return {
      ok: false,
      reason: enable
        ? "mac helper did not enable Fn push-to-talk"
        : "mac helper did not disable Fn push-to-talk",
    };
  }

  log.info(
    enable
      ? "[mac-helper] enabled Fn push-to-talk"
      : "[mac-helper] disabled Fn push-to-talk",
  );
  return { ok: true, enabled: helperRegistered };
};

const syncFnPushToTalkRegistration = (): Promise<FnPushToTalkResult> => {
  if (helperRegistrationSync) return helperRegistrationSync;

  const sync = (async (): Promise<FnPushToTalkResult> => {
    while (helperRegistered !== shouldRegisterHelper()) {
      const shouldRegister = shouldRegisterHelper();
      const result = await setHelperRegistration(shouldRegister);
      if (!result.ok) return result;
    }
    return { ok: true, enabled: helperRegistered };
  })();
  helperRegistrationSync = sync;
  void sync.finally(() => {
    if (helperRegistrationSync === sync) {
      helperRegistrationSync = null;
    }
  });

  return sync;
};

const sendHotkeyEventToOwner = (event: HotkeyEvent): void => {
  pttIsDown = event.state === "down";
  const ownerId = activeHotkeyOwnerId ?? newestOwnerId();
  const activeOwner = ownerId !== null ? hotkeyOwners.get(ownerId) : null;
  const owner =
    activeOwner && !activeOwner.webContents.isDestroyed()
      ? activeOwner
      : hotkeyOwners.get(newestOwnerId() ?? -1);
  if (!owner || owner.webContents.isDestroyed()) return;
  owner.webContents.send("vellum:helper:hotkey:event", event);
};

const sendSyntheticHotkeyUpIfNeeded = (): void => {
  if (!pttIsDown) return;
  pttIsDown = false;
  sendHotkeyEventToOwner({ kind: "fnPushToTalk", state: "up" });
};

const sendHelperStateToRenderers = (state: MacHelperState): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue;
    win.webContents.send("vellum:helper:state", state);
  }
};

const restoreHotkeyRegistrationIfNeeded = async (): Promise<void> => {
  if (
    !restoreHotkeyAfterRestart ||
    restoreHotkeyInFlight ||
    helperRegistered ||
    hotkeyOwners.size === 0
  ) {
    return;
  }

  restoreHotkeyInFlight = true;
  const result = await syncFnPushToTalkRegistration();
  restoreHotkeyInFlight = false;
  if (result.ok) {
    restoreHotkeyAfterRestart = !result.enabled;
    if (result.enabled) {
      log.info("[mac-helper] restored Fn push-to-talk after helper restart");
    }
  } else {
    log.warn(
      `[mac-helper] failed to restore Fn push-to-talk: ${result.reason}`,
    );
  }
};

const handleHelperState = (state: MacHelperState): void => {
  sendHelperStateToRenderers(state);
  if (state.status === "running") {
    void restoreHotkeyRegistrationIfNeeded();
    return;
  }

  if (helperRegistered && hotkeyOwners.size > 0) {
    restoreHotkeyAfterRestart = true;
  }
  helperRegistered = false;
  // The partials session lived in the dead helper process; the renderer's
  // session simply continues without live text.
  dictationPartialsOwner = null;
  dictationFinalOwner = null;
  sendSyntheticHotkeyUpIfNeeded();
};

const restartHelper = (): HelperRestartResult => {
  try {
    const state = client.retry();
    return { ok: true, state };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      state: client.getState(),
    };
  }
};

let installed = false;
let unsubscribeHotkeyEvents: (() => void) | null = null;
let unsubscribeHelperState: (() => void) | null = null;
let unsubscribeDictationPartials: (() => void) | null = null;
let unsubscribeDictationFinalized: (() => void) | null = null;
let unsubscribeDictationTranscribed: (() => void) | null = null;
let unsubscribeDictationError: (() => void) | null = null;

export const installHotkeyHelper = (): void => {
  if (installed) return;
  installed = true;

  unsubscribeHotkeyEvents = client.onNotification(
    "hotkey.event",
    HOTKEY_EVENT_SCHEMA,
    (event) => {
      sendHotkeyEventToOwner(event);
    },
  );
  unsubscribeDictationPartials = client.onNotification(
    "dictation.partial",
    DICTATION_PARTIAL_SCHEMA,
    (event) => {
      sendDictationPartialToOwner(event);
    },
  );
  unsubscribeDictationFinalized = client.onNotification(
    "dictation.finalized",
    DICTATION_PARTIAL_SCHEMA,
    (event) => {
      sendDictationTextEventToOwner("finalized", event);
    },
  );
  unsubscribeDictationTranscribed = client.onNotification(
    "dictation.transcribed",
    DICTATION_PARTIAL_SCHEMA,
    (event) => {
      sendDictationTextEventToOwner("transcribed", event);
    },
  );
  unsubscribeDictationError = client.onNotification(
    "dictation.error",
    DICTATION_ERROR_SCHEMA,
    (event) => {
      // Field-debuggable trace for recognition dying mid-session (the
      // helper retries on the server path when the on-device pin fails).
      log.warn(
        `[mac-helper] dictation recognition error (onDevice=${event.onDevice}, retryServer=${event.willRetryServer}): ${event.message}`,
      );
    },
  );
  unsubscribeHelperState = client.onState(handleHelperState);

  handle("vellum:helper:ping", z.tuple([]), () => ping());
  handle("vellum:helper:state:get", z.tuple([]), () => client.getState());
  handle("vellum:helper:restart", z.tuple([]), () => restartHelper());

  handle(
    "vellum:helper:hotkey:fnPushToTalk",
    z.tuple([z.boolean()]),
    ([enable], event) =>
      enable
        ? enableFnPushToTalkForOwner(event.sender)
        : disableFnPushToTalkForOwner(event.sender),
  );

  handle(
    "vellum:helper:dictation:setPartials",
    z.tuple([z.boolean(), z.string().optional(), z.boolean().optional()]),
    ([enable, deviceName, pushAudio], event) =>
      setDictationPartials(event.sender, enable, deviceName, pushAudio),
  );

  // High-frequency fire-and-forget PCM from the partials owner — plain
  // `on`, not `handle`: a round-trip per ~100ms chunk buys nothing.
  ipcMain.on("vellum:helper:dictation:audio", (event, chunk: unknown) => {
    if (event.sender !== dictationPartialsOwner) {
      audioChunkCount += 1;
      if (audioChunkCount === 1 || audioChunkCount % 50 === 0) {
        log.warn(
          `[mac-helper] dictation audio chunk #${audioChunkCount} DROPPED (sender wc=${event.sender.id} is not the partials owner)`,
        );
      }
      return;
    }
    const buf = toAudioBuffer(chunk);
    if (!buf || buf.length === 0) return;
    audioChunkCount += 1;
    if (audioChunkCount === 1 || audioChunkCount % 50 === 0) {
      // Byte counts only — never audio content.
      log.info(
        `[mac-helper] dictation audio chunk #${audioChunkCount} → helper (${buf.length} bytes)`,
      );
    }
    void client
      .call("dictation.appendAudio", { audio: buf.toString("base64") })
      .catch(() => {
        // Helper restarting mid-session — chunks are best-effort.
      });
  });

  handle(
    "vellum:helper:dictation:transcribe",
    z.tuple([z.unknown()]),
    async ([audio], event): Promise<{ ok: boolean; reason?: string }> => {
      const buf = toAudioBuffer(audio);
      if (!buf || buf.length === 0) {
        return { ok: false, reason: "empty audio" };
      }
      // Route the upcoming `dictation.transcribed` to the requester.
      dictationFinalOwner = event.sender;
      try {
        const result = await client.call("dictation.transcribe", {
          audio: buf.toString("base64"),
          sampleRate: DICTATION_PUSH_SAMPLE_RATE,
        });
        const parsed = DICTATION_TRANSCRIBE_RESULT_SCHEMA.safeParse(result);
        if (!parsed.success) {
          return { ok: false, reason: "invalid transcribe result" };
        }
        return parsed.data;
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  app.on("before-quit", () => {
    client.shutdown({
      method: "hotkey.fnPushToTalk",
      params: { enable: false },
    });
  });
};

export const __resetForTesting = (): void => {
  installed = false;
  ipcMain.removeAllListeners("vellum:helper:dictation:audio");
  platformForTesting = null;
  supervisorOptionsForTesting = {};
  helperRegistered = false;
  helperRegistrationSync = null;
  restoreHotkeyAfterRestart = false;
  restoreHotkeyInFlight = false;
  pttIsDown = false;
  unsubscribeHotkeyEvents?.();
  unsubscribeHotkeyEvents = null;
  unsubscribeHelperState?.();
  unsubscribeHelperState = null;
  unsubscribeDictationPartials?.();
  unsubscribeDictationPartials = null;
  unsubscribeDictationError?.();
  unsubscribeDictationError = null;
  unsubscribeDictationFinalized?.();
  unsubscribeDictationFinalized = null;
  unsubscribeDictationTranscribed?.();
  unsubscribeDictationTranscribed = null;
  dictationPartialsOwner = null;
  dictationFinalOwner = null;
  for (const owner of hotkeyOwners.values()) owner.cleanup();
  hotkeyOwners.clear();
  activeHotkeyOwnerId = null;
  client.resetForTesting();
  client = makeClient();
};

export const __setPlatformForTesting = (
  platform: NodeJS.Platform | null,
): void => {
  platformForTesting = platform;
  client.resetForTesting();
  client = makeClient();
};

export const __setSupervisorOptionsForTesting = (
  options: Partial<
    Pick<
      MacHelperClientOptions,
      | "initialBackoffMs"
      | "maxBackoffMs"
      | "stableResetMs"
      | "circuitCrashCount"
      | "circuitWindowMs"
    >
  >,
): void => {
  supervisorOptionsForTesting = options;
  client.resetForTesting();
  client = makeClient();
};
