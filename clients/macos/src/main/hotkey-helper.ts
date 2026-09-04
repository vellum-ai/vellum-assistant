import { BrowserWindow, app, ipcMain, type WebContents } from "electron";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import {
  FN_CLAIMANT_BUNDLE_IDS,
  HELPER_APPS_FRONTMOST,
  HELPER_APPS_QUIT,
  HELPER_APPS_RUNNING,
  HELPER_INPUT_ACTIVITY_EVENT,
  HELPER_INPUT_SET_ACTIVITY_WATCH,
  HELPER_DICTATION_FINALIZED_EVENT,
  HELPER_DICTATION_PARTIAL_EVENT,
  HELPER_DICTATION_SET_PARTIALS,
  HELPER_DICTATION_TRANSCRIBE,
  HELPER_DICTATION_TRANSCRIBED_EVENT,
  HELPER_HOTKEY_READ_FRONT_SELECTION,
  HELPER_HOTKEY_SET_MODIFIER_HOLD,
} from "@vellumai/ipc-contract";
import {
  DICTATION_PUSH_SAMPLE_RATE,
  dictationPartialsHelperResultSchema,
  DictationOwnerRouter,
  requestDictationTranscription,
  toAudioBuffer,
} from "@vellumai/electron-desktop/dictation-routing";
import type {
  DictationPartialEvent,
  DictationPartialsResult,
  HelperRestartResult,
  HelperState,
  HotkeyEvent,
  HotkeyEventState,
  HotkeySelection,
  ModifierHold,
  ModifierHoldRegistrationResult,
} from "@vellumai/ipc-contract";

import { isPointerOnCompanion } from "./companion-pointer";
import { handle } from "./ipc";
import log from "./logger";
import {
  MacHelperClient,
  type MacHelperClientOptions,
  type MacHelperState,
} from "./sidecar/mac-helper.client";
import {
  getMacHelperAppPath,
  getMacHelperPath,
} from "./sidecar/mac-helper-path";

export type {
  DictationPartialEvent,
  DictationPartialsResult,
  HelperRestartResult,
  HelperState,
  HotkeyEvent,
  HotkeyEventState,
  ModifierHold,
  ModifierHoldRegistrationResult,
};

export type MacHelperPermissionKind = "speechRecognition" | "inputMonitoring";

export type MacHelperPermissionStatus =
  | "unknown"
  | "restricted"
  | "denied"
  | "not-determined"
  | "granted";

const HOTKEY_EVENT_SCHEMA = z.object({
  kind: z.literal("modifierHold"),
  state: z.enum(["down", "up"]),
  reason: z.enum(["released", "chord", "cancelled"]).optional(),
});

const FRONT_SELECTION_SCHEMA = z.object({
  selection: z
    .object({
      text: z.string(),
      truncated: z.boolean(),
      // A helper built before the flag existed says nothing about it, and a
      // selection of unknown editability is one the words are asked about.
      editable: z.boolean().default(false),
    })
    .optional(),
});

const RUNNING_APPS_SCHEMA = z.object({
  running: z.array(z.string()),
});

const QUIT_APP_SCHEMA = z.object({
  asked: z.boolean(),
});

const FRONTMOST_APP_SCHEMA = z.object({
  bundleId: z.string().nullable(),
});

const FRONT_FOCUS_SCHEMA = z.object({
  focused: z.boolean(),
  takesText: z.boolean(),
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

/**
 * The binding the helper is currently holding, so a clear that has nothing to
 * clear stays off the wire. Teardown runs on paths the hold was never used on,
 * and the helper's stdin is shared with dictation. Also what a helper that
 * comes back from a crash is handed, so the key survives the restart.
 */
let modifierHoldBinding: ModifierHold = { kind: "off" };

/**
 * The binding the caller last asked for, and the call carrying one to the
 * helper, so the last word wins.
 *
 * Registrations arrive in bursts: a renderer that reloads tears its binding
 * down and puts it back, and both are calls over the same pipe. Run
 * concurrently they can land in the other order, leaving the helper cleared
 * while the app believes it is armed, which reads as the keys going dead until
 * the next restart. Chaining is what keeps the order the caller's.
 */
let desiredModifierHold: ModifierHold = { kind: "off" };
let modifierHoldInFlight: Promise<ModifierHoldRegistrationResult> | null = null;

/**
 * Point the helper's hold detector at a modifier set, or clear it.
 *
 * The set crosses as names rather than a mask: the helper owns which bits a
 * modifier is, left and right hand alike, and neither side should hold a second
 * copy of that table.
 */
const setModifierHold = async (
  hold: ModifierHold,
): Promise<ModifierHoldRegistrationResult> => {
  desiredModifierHold = hold;
  const run = async (): Promise<ModifierHoldRegistrationResult> => {
    await modifierHoldInFlight?.catch(() => undefined);
    // Whatever was asked for last, which may no longer be what this call
    // carried: a burst collapses to one registration rather than a queue of
    // them fighting.
    return applyModifierHold(desiredModifierHold);
  };
  const call = run();
  modifierHoldInFlight = call;
  void call.finally(() => {
    if (modifierHoldInFlight === call) {
      modifierHoldInFlight = null;
    }
  });
  return call;
};

const applyModifierHold = async (
  hold: ModifierHold,
): Promise<ModifierHoldRegistrationResult> => {
  if (hold.kind === "off" && modifierHoldBinding.kind === "off") {
    return { ok: true, enabled: false };
  }
  modifierHoldBinding = hold;
  return sendModifierHold(hold);
};

const sendModifierHold = async (
  hold: ModifierHold,
): Promise<ModifierHoldRegistrationResult> => {
  try {
    const result = await client.call(
      "hotkey.modifierHold",
      hold.kind === "off"
        ? { enable: false }
        : { enable: true, modifiers: hold.modifiers },
    );
    const parsed = HOTKEY_RESULT_SCHEMA.safeParse(result);
    if (!parsed.success) {
      return { ok: false, reason: "mac helper returned invalid hotkey result" };
    }
    helperHoldsBinding = hold.kind !== "off" && parsed.data.enabled;
    return { ok: true, enabled: parsed.data.enabled };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};

/**
 * What is highlighted in the application in front, or `null` when nothing is
 * or the helper cannot say. A refusal reads as no selection rather than as an
 * error: the hold that asks lands its words at the cursor either way.
 */
const readFrontSelection = async (): Promise<HotkeySelection | null> => {
  try {
    const result = await client.call("selection.read");
    const parsed = FRONT_SELECTION_SCHEMA.safeParse(result);
    if (!parsed.success) {
      log.warn("[mac-helper] selection read returned an invalid result");
      return null;
    }
    return parsed.data.selection ?? null;
  } catch (err) {
    log.warn(
      `[mac-helper] selection read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
};

/**
 * Which of the named applications are running. A helper that cannot say
 * reads as none running: the voice key arms, which is the answer with no
 * information rather than a key that stays dead on a hunch.
 */
const runningApps = async (bundleIds: string[]): Promise<string[]> => {
  // Only the apps the voice key has business with. The renderer never gets
  // to enumerate the desktop through this.
  const wanted = bundleIds.filter((id) => FN_CLAIMANT_BUNDLE_IDS.includes(id));
  if (wanted.length === 0) {
    return [];
  }
  try {
    const result = await client.call("apps.running", { bundleIds: wanted });
    const parsed = RUNNING_APPS_SCHEMA.safeParse(result);
    return parsed.success ? parsed.data.running : [];
  } catch (err) {
    log.warn(
      `[mac-helper] running apps query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
};

/**
 * Ask an application to quit. `false` when it was not running or the helper
 * could not ask, and `false` without asking for any app outside the voice
 * key's claimants: this is the one thing the renderer can do to another app,
 * and the allowlist is held here rather than trusted from there.
 */
const quitApp = async (bundleId: string): Promise<boolean> => {
  if (!FN_CLAIMANT_BUNDLE_IDS.includes(bundleId)) {
    log.warn(
      `[mac-helper] refused to quit ${bundleId}: not a voice key claimant`,
    );
    return false;
  }
  try {
    const result = await client.call("apps.quit", { bundleId });
    const parsed = QUIT_APP_SCHEMA.safeParse(result);
    return parsed.success && parsed.data.asked;
  } catch (err) {
    log.warn(
      `[mac-helper] quit app failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
};

/** The bundle identifier of the application in front, or `null` when the helper cannot say. */
const frontmostApp = async (): Promise<string | null> => {
  try {
    const result = await client.call("apps.frontmost");
    const parsed = FRONTMOST_APP_SCHEMA.safeParse(result);
    return parsed.success ? parsed.data.bundleId : null;
  } catch (err) {
    log.warn(
      `[mac-helper] frontmost app query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
};

/**
 * Whether the renderer has asked for the input watch, so a helper that comes
 * back from a crash is put back to watching. The renderer asks once and is
 * not told about the restart, and a watch that silently stopped would let an
 * offer outlive the edit it means to replace.
 */
let desiredInputActivityWatch = false;

const setInputActivityWatch = async (enable: boolean): Promise<boolean> => {
  desiredInputActivityWatch = enable;
  return sendInputActivityWatch(enable);
};

const sendInputActivityWatch = async (enable: boolean): Promise<boolean> => {
  try {
    const result = await client.call("input.setActivityWatch", { enable });
    const parsed = HOTKEY_RESULT_SCHEMA.safeParse(result);
    return parsed.success && parsed.data.enabled === enable;
  } catch (err) {
    log.warn(
      `[mac-helper] input activity watch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
};

/**
 * Whether a paste sent to the application in front would land in something
 * that takes text.
 *
 * True on every answer but a confident no. A helper that is not running, not
 * trusted, or slow to answer cannot see a text field that is genuinely there,
 * and the cost of the two mistakes is not the same: withholding a paste that
 * would have worked breaks dictation into that application, where sending one
 * that lands nowhere is caught downstream and the words are offered instead.
 */
export const frontAppTakesText = async (): Promise<boolean> => {
  try {
    const result = await client.call("focus.read");
    const parsed = FRONT_FOCUS_SCHEMA.safeParse(result);
    if (!parsed.success) {
      log.warn("[mac-helper] focus read returned an invalid result");
      return true;
    }
    return parsed.data.takesText;
  } catch (err) {
    log.warn(
      `[mac-helper] focus read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
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
    await openMacHelperApp([
      "--permission-status",
      kind,
      "--status-output",
      outputPath,
    ]);
    return await readPermissionStatusFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

const openMacHelperApp = async (helperArgs: string[]): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const args = ["-n", getMacHelperAppPath(), "--args", ...helperArgs];
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

const MODIFIER_HOLD_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("off") }),
  z.object({
    kind: z.literal("modifierOnly"),
    modifiers: z
      .array(z.enum(["function", "control", "shift", "option", "command"]))
      .min(1),
  }),
]);

const dictationOwners = new DictationOwnerRouter();

// The renderer's push pipeline downsamples to 16 kHz mono Int16 (the
// pcm-downsample worklet contract).
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
    const parsed = dictationPartialsHelperResultSchema.safeParse(result);
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
    const previousOwner = dictationOwners.setOwner(webContents, enable);
    if (enable) {
      forwardedPartialCount = 0;
      audioChunkCount = 0;
    }
    const replaced =
      previousOwner &&
      previousOwner !== webContents &&
      !previousOwner.isDestroyed()
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

const sendDictationPartialToOwner = (event: DictationPartialEvent): void => {
  forwardedPartialCount += 1;
  const owner = dictationOwners.target();
  if (forwardedPartialCount === 1 || forwardedPartialCount % 25 === 0) {
    // Count/length only — transcript content must never be logged.
    log.info(
      `[mac-helper] dictation partial #${forwardedPartialCount} chars=${event.text.length} → ${owner ? `wc=${owner.id}` : "DROPPED (no owner)"}`,
    );
  }
  if (!owner) {
    return;
  }
  owner.send(HELPER_DICTATION_PARTIAL_EVENT, event);
};

const sendDictationTextEventToOwner = (
  kind: "finalized" | "transcribed",
  event: DictationPartialEvent,
): void => {
  const owner =
    kind === "transcribed"
      ? dictationOwners.takeTranscriptionTarget()
      : dictationOwners.target();
  // Length only; transcript content must never be logged.
  log.info(
    `[mac-helper] dictation ${kind} chars=${event.text.length} -> ${owner ? `wc=${owner.id}` : "DROPPED (no owner)"}`,
  );
  if (!owner) {
    return;
  }
  owner.send(
    kind === "finalized"
      ? HELPER_DICTATION_FINALIZED_EVENT
      : HELPER_DICTATION_TRANSCRIBED_EVENT,
    event,
  );
};

const hotkeyOwners = new Map<number, HotkeyOwner>();
let activeHotkeyOwnerId: number | null = null;
/** Whether the running helper has taken the binding, as far as main knows. */
let helperHoldsBinding = false;
/** Whether the helper that comes back next is owed the binding it died with. */
let restoreHoldAfterRestart = false;
let restoreHoldInFlight = false;
let holdIsOpen = false;

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

const releaseHotkeyOwner = (webContents: WebContents): void => {
  removeHotkeyOwner(webContents.id);

  if (hotkeyOwners.size === 0) {
    // Nothing is left to receive the edges, so a hold still armed in the
    // helper would open a microphone into a window that is gone.
    void setModifierHold({ kind: "off" });
  }
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
    releaseHotkeyOwner(webContents);
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

/** The window the key's events go to: the active owner, else the newest live one. */
const hotkeyOwnerTarget = (): WebContents | null => {
  const ownerId = activeHotkeyOwnerId ?? newestOwnerId();
  const activeOwner = ownerId !== null ? hotkeyOwners.get(ownerId) : null;
  const owner =
    activeOwner && !activeOwner.webContents.isDestroyed()
      ? activeOwner
      : hotkeyOwners.get(newestOwnerId() ?? -1);
  if (!owner || owner.webContents.isDestroyed()) return null;
  return owner.webContents;
};

const sendHotkeyEventToOwner = (event: HotkeyEvent): void => {
  holdIsOpen = event.state === "down";
  hotkeyOwnerTarget()?.send("vellum:helper:hotkey:event", event);
};

const sendInputActivityToOwner = (): void => {
  // A press on the companion is a press on Vellum's own controls: the offer
  // those controls answer must not be taken down by the click answering it.
  if (isPointerOnCompanion()) {
    return;
  }
  hotkeyOwnerTarget()?.send(HELPER_INPUT_ACTIVITY_EVENT);
};

/**
 * Close the hold the dead helper left open. Its consumer is a microphone that
 * closes on the `up`, and the edge has to say the user did not let go.
 */
const sendSyntheticHotkeyUpIfNeeded = (): void => {
  if (!holdIsOpen) {
    return;
  }
  holdIsOpen = false;
  sendHotkeyEventToOwner({
    kind: "modifierHold",
    state: "up",
    reason: "cancelled",
  });
};

const sendHelperStateToRenderers = (state: MacHelperState): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue;
    win.webContents.send("vellum:helper:state", state);
  }
};

/**
 * Hand a helper that has just come back the binding the app believes it holds.
 * The renderer registered once and is not told about the restart, so without
 * this the key is dead until the next reload.
 */
const restoreModifierHoldIfNeeded = async (): Promise<void> => {
  if (
    !restoreHoldAfterRestart ||
    restoreHoldInFlight ||
    modifierHoldBinding.kind === "off" ||
    hotkeyOwners.size === 0
  ) {
    return;
  }

  restoreHoldInFlight = true;
  const result = await sendModifierHold(modifierHoldBinding);
  restoreHoldInFlight = false;
  if (result.ok && result.enabled) {
    restoreHoldAfterRestart = false;
    log.info("[mac-helper] restored the voice key after helper restart");
  } else {
    log.warn(
      `[mac-helper] failed to restore the voice key: ${result.ok ? "helper refused" : result.reason}`,
    );
  }
};

const handleHelperState = (state: MacHelperState): void => {
  sendHelperStateToRenderers(state);
  if (state.status === "running") {
    void restoreModifierHoldIfNeeded();
    // The watch went down with the helper the binding did, and the renderer
    // asks for neither again. Restored beside the binding rather than behind
    // it: they are two registrations, and an offer outliving the edit it
    // means to replace must not wait on a hold's round trip.
    if (desiredInputActivityWatch) {
      void sendInputActivityWatch(true);
    }
    return;
  }

  if (helperHoldsBinding) {
    helperHoldsBinding = false;
    restoreHoldAfterRestart = true;
  }
  // The partials session lived in the dead helper process; the renderer's
  // session simply continues without live text.
  dictationOwners.clear();
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
let unsubscribeInputActivity: (() => void) | null = null;
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
  unsubscribeInputActivity = client.onNotification(
    "input.activity",
    z.unknown(),
    () => {
      sendInputActivityToOwner();
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
    HELPER_HOTKEY_SET_MODIFIER_HOLD,
    z.tuple([MODIFIER_HOLD_SCHEMA]),
    ([hold], event) => {
      // The edges reach whichever window asked for the binding: a microphone
      // bracketed by them belongs to the window that opened it. Clearing the
      // binding leaves the ownership alone, since the window may be about to
      // register another.
      if (hold.kind !== "off") {
        // The binding is inert without Input Monitoring. The renderer asks for
        // the grant when it arms the key; a press cannot be the moment, since
        // noticing the press is the thing being asked for.
        addHotkeyOwner(event.sender);
      }
      return setModifierHold(hold);
    },
  );

  handle(HELPER_HOTKEY_READ_FRONT_SELECTION, z.tuple([]), () =>
    readFrontSelection(),
  );

  handle(HELPER_APPS_RUNNING, z.tuple([z.array(z.string()).max(32)]), ([ids]) =>
    runningApps(ids),
  );
  handle(HELPER_APPS_QUIT, z.tuple([z.string().max(255)]), ([bundleId]) =>
    quitApp(bundleId),
  );
  handle(HELPER_APPS_FRONTMOST, z.tuple([]), () => frontmostApp());
  handle(HELPER_INPUT_SET_ACTIVITY_WATCH, z.tuple([z.boolean()]), ([enable]) =>
    setInputActivityWatch(enable),
  );

  handle(
    HELPER_DICTATION_SET_PARTIALS,
    z.tuple([z.boolean(), z.string().optional(), z.boolean().optional()]),
    ([enable, deviceName, pushAudio], event) =>
      setDictationPartials(event.sender, enable, deviceName, pushAudio),
  );

  // High-frequency fire-and-forget PCM from the partials owner — plain
  // `on`, not `handle`: a round-trip per ~100ms chunk buys nothing.
  ipcMain.on("vellum:helper:dictation:audio", (event, chunk: unknown) => {
    if (!dictationOwners.ownsPartials(event.sender)) {
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
    HELPER_DICTATION_TRANSCRIBE,
    z.tuple([z.unknown()]),
    ([audio], event) =>
      requestDictationTranscription({
        audio,
        sender: event.sender,
        owners: dictationOwners,
        client,
      }),
  );

  app.on("before-quit", () => {
    client.shutdown({
      method: "hotkey.modifierHold",
      params: { enable: false },
    });
  });
};

export const __resetForTesting = (): void => {
  installed = false;
  ipcMain.removeAllListeners("vellum:helper:dictation:audio");
  platformForTesting = null;
  supervisorOptionsForTesting = {};
  modifierHoldBinding = { kind: "off" };
  desiredModifierHold = { kind: "off" };
  modifierHoldInFlight = null;
  helperHoldsBinding = false;
  restoreHoldAfterRestart = false;
  restoreHoldInFlight = false;
  desiredInputActivityWatch = false;
  holdIsOpen = false;
  unsubscribeHotkeyEvents?.();
  unsubscribeHotkeyEvents = null;
  unsubscribeInputActivity?.();
  unsubscribeInputActivity = null;
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
  dictationOwners.clear();
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
