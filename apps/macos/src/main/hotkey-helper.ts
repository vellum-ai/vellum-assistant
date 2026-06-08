import { BrowserWindow, app, type WebContents } from "electron";
import path from "node:path";
import { z } from "zod";

import { handle } from "./ipc";
import log from "./logger";
import {
  MacHelperClient,
  type MacHelperClientOptions,
  type MacHelperState,
} from "./sidecar/mac-helper";

export type HotkeyEventState = "down" | "up";

export interface HotkeyEvent {
  kind: "fnPushToTalk";
  state: HotkeyEventState;
}

export type FnPushToTalkResult =
  | { ok: true; enabled: boolean }
  | { ok: false; reason: string };

export type HelperRestartResult =
  | { ok: true; state: MacHelperState }
  | { ok: false; reason: string; state: MacHelperState };

const HOTKEY_EVENT_SCHEMA = z.object({
  kind: z.literal("fnPushToTalk"),
  state: z.enum(["down", "up"]),
});

const HOTKEY_RESULT_SCHEMA = z.object({
  enabled: z.boolean(),
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

export const getHotkeyHelperPath = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "hotkey-helper");
  }
  return path.join(app.getAppPath(), "resources", "hotkey-helper");
};

const makeClient = (): MacHelperClient =>
  new MacHelperClient({
    name: "hotkey helper",
    resolveExecutablePath: getHotkeyHelperPath,
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
      return { ok: false, reason: "hotkey helper returned invalid result" };
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
    throw new Error("hotkey helper returned invalid ping result");
  }
  return "pong";
};

interface HotkeyOwner {
  webContents: WebContents;
  cleanup: () => void;
}

const hotkeyOwners = new Map<number, HotkeyOwner>();
let activeHotkeyOwnerId: number | null = null;
let helperRegistered = false;
let restoreHotkeyAfterRestart = false;
let restoreHotkeyInFlight = false;
let pttIsDown = false;

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

  if (hotkeyOwners.size > 0) {
    return { ok: true, enabled: true };
  }
  restoreHotkeyAfterRestart = false;
  if (!helperRegistered) {
    return { ok: true, enabled: false };
  }

  const result = await fnPushToTalk(false);
  if (result.ok) {
    helperRegistered = false;
    log.info("[hotkey-helper] disabled Fn push-to-talk");
  }
  return result;
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

  if (helperRegistered) {
    return { ok: true, enabled: true };
  }

  const result = await fnPushToTalk(true);
  if (result.ok) {
    helperRegistered = result.enabled;
    log.info("[hotkey-helper] enabled Fn push-to-talk");
  } else {
    log.warn(
      `[hotkey-helper] failed to enable Fn push-to-talk: ${result.reason}`,
    );
    removeHotkeyOwner(webContents.id);
  }
  return result;
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
  const result = await fnPushToTalk(true);
  restoreHotkeyInFlight = false;
  if (result.ok) {
    helperRegistered = result.enabled;
    restoreHotkeyAfterRestart = !result.enabled;
    if (result.enabled) {
      log.info("[hotkey-helper] restored Fn push-to-talk after helper restart");
    }
  } else {
    log.warn(
      `[hotkey-helper] failed to restore Fn push-to-talk: ${result.reason}`,
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

  app.on("before-quit", () => {
    client.shutdown({
      method: "hotkey.fnPushToTalk",
      params: { enable: false },
    });
  });
};

export const __resetForTesting = (): void => {
  installed = false;
  platformForTesting = null;
  supervisorOptionsForTesting = {};
  helperRegistered = false;
  restoreHotkeyAfterRestart = false;
  restoreHotkeyInFlight = false;
  pttIsDown = false;
  unsubscribeHotkeyEvents?.();
  unsubscribeHotkeyEvents = null;
  unsubscribeHelperState?.();
  unsubscribeHelperState = null;
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
