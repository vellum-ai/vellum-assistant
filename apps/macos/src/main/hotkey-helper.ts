import { BrowserWindow, app, type WebContents } from "electron";
import path from "node:path";
import { z } from "zod";

import { handle } from "./ipc";
import log from "./logger";
import { onSettingChange, readSetting, writeSetting } from "./settings";
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

export type PttModifier =
  | "function"
  | "control"
  | "shift"
  | "option"
  | "command"
  | "rightCommand"
  | "rightOption";

export type PttConfig =
  | { kind: "none" }
  | { kind: "modifierOnly"; modifiers: PttModifier[] }
  | { kind: "key"; keyCode: number; code?: string; label?: string }
  | {
      kind: "modifierKey";
      modifiers: PttModifier[];
      keyCode: number;
      code?: string;
      label?: string;
    }
  | { kind: "mouseButton"; button: number };

export interface PttEvent {
  state: HotkeyEventState;
}

export interface PttConfigState {
  config: PttConfig;
  isStored: boolean;
}

export type FnPushToTalkResult =
  | { ok: true; enabled: boolean }
  | { ok: false; reason: string };

export type PttRegistrationResult =
  | { ok: true; enabled: boolean; config: PttConfig }
  | { ok: false; reason: string };

export type HelperRestartResult =
  | { ok: true; state: MacHelperState }
  | { ok: false; reason: string; state: MacHelperState };

export type DictationPartialsResult =
  | { ok: true; enabled: boolean }
  | { ok: false; reason: string };

export interface DictationPartialEvent {
  text: string;
}

const HOTKEY_EVENT_SCHEMA = z.object({
  kind: z.literal("fnPushToTalk"),
  state: z.enum(["down", "up"]),
});

const PTT_MODIFIER_SCHEMA = z.enum([
  "function",
  "control",
  "shift",
  "option",
  "command",
  "rightCommand",
  "rightOption",
]);

const PTT_CONFIG_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("modifierOnly"),
    modifiers: z.array(PTT_MODIFIER_SCHEMA).min(1),
  }),
  z.object({
    kind: z.literal("key"),
    keyCode: z.number().int().nonnegative(),
    code: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal("modifierKey"),
    modifiers: z.array(PTT_MODIFIER_SCHEMA).min(1),
    keyCode: z.number().int().nonnegative(),
    code: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal("mouseButton"),
    button: z.number().int().nonnegative(),
  }),
]) satisfies z.ZodType<PttConfig>;

const PTT_EVENT_SCHEMA = z.object({
  state: z.enum(["down", "up"]),
});

const HOTKEY_RESULT_SCHEMA = z.object({
  enabled: z.boolean(),
});

const PTT_RESULT_SCHEMA = z.object({
  enabled: z.boolean(),
});

const DICTATION_PARTIAL_SCHEMA = z.object({
  text: z.string(),
});

const DICTATION_RESULT_SCHEMA = z.object({
  enabled: z.boolean(),
  reason: z.string().optional(),
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

const NONE_PTT_CONFIG: PttConfig = { kind: "none" };
const DEFAULT_PTT_CONFIG: PttConfig = {
  kind: "modifierOnly",
  modifiers: ["function"],
};
const PTT_HOTKEY_SETTING_KEY = "ptt";

export const getMacHelperPath = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "bin", "vellum-mac-helper");
  }
  return path.join(app.getAppPath(), "resources", "vellum-mac-helper");
};

const makeClient = (): MacHelperClient =>
  new MacHelperClient({
    name: "mac helper",
    resolveExecutablePath: getMacHelperPath,
    logger: log,
    platform: getPlatform(),
    ...supervisorOptionsForTesting,
  });

let client = makeClient();

const normalizePttConfig = (config: PttConfig): PttConfig => {
  switch (config.kind) {
    case "modifierOnly":
      return {
        kind: "modifierOnly",
        modifiers: Array.from(new Set(config.modifiers)).sort(),
      };
    case "modifierKey":
      return {
        ...config,
        modifiers: Array.from(new Set(config.modifiers)).sort(),
      };
    default:
      return config;
  }
};

const pttConfigsEqual = (a: PttConfig, b: PttConfig): boolean =>
  JSON.stringify(normalizePttConfig(a)) ===
  JSON.stringify(normalizePttConfig(b));

const parseStoredPttConfig = (raw: unknown): PttConfig => {
  const parsed = PTT_CONFIG_SCHEMA.safeParse(raw);
  return parsed.success ? normalizePttConfig(parsed.data) : DEFAULT_PTT_CONFIG;
};

const readPttConfigState = (): PttConfigState => {
  const raw = readSetting("hotkeys")?.[PTT_HOTKEY_SETTING_KEY];
  const parsed = PTT_CONFIG_SCHEMA.safeParse(raw);
  return {
    config: parsed.success
      ? normalizePttConfig(parsed.data)
      : DEFAULT_PTT_CONFIG,
    isStored: parsed.success,
  };
};

const readPttConfig = (): PttConfig =>
  readPttConfigState().config;

const writePttConfig = (config: PttConfig): PttConfig => {
  const normalized = normalizePttConfig(config);
  const next = { ...(readSetting("hotkeys") ?? {}) };
  next[PTT_HOTKEY_SETTING_KEY] = normalized;
  writeSetting("hotkeys", next);
  return normalized;
};

const broadcastPttConfig = (): void => {
  const config = readPttConfig();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue;
    win.webContents.send("vellum:ptt:configChanged", config);
  }
};

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

const setNativePttConfig = async (
  config: PttConfig,
): Promise<PttRegistrationResult> => {
  const normalized = normalizePttConfig(config);
  try {
    const result = await client.call("ptt.setConfig", { config: normalized });
    const parsed = PTT_RESULT_SCHEMA.safeParse(result);
    if (!parsed.success) {
      return { ok: false, reason: "mac helper returned invalid PTT result" };
    }
    const expectedEnabled = normalized.kind !== "none";
    if (parsed.data.enabled !== expectedEnabled) {
      return {
        ok: false,
        reason: expectedEnabled
          ? "mac helper did not enable push-to-talk"
          : "mac helper did not disable push-to-talk",
      };
    }
    return { ok: true, enabled: parsed.data.enabled, config: normalized };
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

interface HotkeyOwner {
  webContents: WebContents;
  cleanup: () => void;
}

interface PttOwner extends HotkeyOwner {
  config: PttConfig;
}

// The renderer that most recently enabled dictation partials — the recording
// session's host. Partial notifications route only there.
let dictationPartialsOwner: WebContents | null = null;

const setDictationPartials = async (
  webContents: WebContents,
  enable: boolean,
): Promise<DictationPartialsResult> => {
  try {
    const result = await client.call("dictation.setPartials", { enable });
    const parsed = DICTATION_RESULT_SCHEMA.safeParse(result);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "mac helper returned invalid dictation result",
      };
    }
    if (enable && !parsed.data.enabled) {
      return { ok: false, reason: parsed.data.reason ?? "unavailable" };
    }
    dictationPartialsOwner = enable ? webContents : null;
    return { ok: true, enabled: parsed.data.enabled };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};

const sendDictationPartialToOwner = (event: DictationPartialEvent): void => {
  if (!dictationPartialsOwner || dictationPartialsOwner.isDestroyed()) return;
  dictationPartialsOwner.send("vellum:helper:dictation:partial", event);
};

const hotkeyOwners = new Map<number, HotkeyOwner>();
let activeHotkeyOwnerId: number | null = null;
let helperRegistered = false;
let helperRegistrationSync: Promise<FnPushToTalkResult> | null = null;
let restoreHotkeyAfterRestart = false;
let restoreHotkeyInFlight = false;
let pttIsDown = false;

const pttOwners = new Map<number, PttOwner>();
let activePttOwnerId: number | null = null;
let helperPttConfig: PttConfig = NONE_PTT_CONFIG;
let helperPttSync: Promise<PttRegistrationResult> | null = null;
let restorePttAfterRestart = false;
let restorePttInFlight = false;
let nativePttIsDown = false;

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

const newestPttOwnerId = (): number | null => {
  let id: number | null = null;
  for (const [ownerId, owner] of pttOwners) {
    if (!owner.webContents.isDestroyed()) id = ownerId;
  }
  return id;
};

const desiredPttConfig = (): PttConfig => {
  const ownerId = activePttOwnerId ?? newestPttOwnerId();
  const owner = ownerId !== null ? pttOwners.get(ownerId) : null;
  return owner && !owner.webContents.isDestroyed()
    ? owner.config
    : NONE_PTT_CONFIG;
};

const removePttOwner = (webContentsId: number): void => {
  const owner = pttOwners.get(webContentsId);
  if (!owner) return;
  owner.cleanup();
  pttOwners.delete(webContentsId);
  if (activePttOwnerId === webContentsId) {
    activePttOwnerId = newestPttOwnerId();
  }
};

const addOrUpdatePttOwner = (
  webContents: WebContents,
  config: PttConfig,
): void => {
  const id = webContents.id;
  const existing = pttOwners.get(id);
  if (existing) {
    existing.config = config;
    activePttOwnerId = id;
    return;
  }

  const win = BrowserWindow.fromWebContents(webContents);
  const markActive = () => {
    if (pttOwners.has(id)) activePttOwnerId = id;
  };
  const handleDestroyed = () => {
    removePttOwner(id);
    void syncPttRegistration();
  };

  webContents.once("destroyed", handleDestroyed);
  win?.on("focus", markActive);

  pttOwners.set(id, {
    webContents,
    config,
    cleanup: () => {
      webContents.off("destroyed", handleDestroyed);
      win?.off("focus", markActive);
    },
  });
  activePttOwnerId = id;
};

const setHelperPttConfig = async (
  config: PttConfig,
): Promise<PttRegistrationResult> => {
  const result = await setNativePttConfig(config);
  if (!result.ok) return result;

  helperPttConfig = result.config;
  log.info(
    result.enabled
      ? `[mac-helper] enabled push-to-talk (${result.config.kind})`
      : "[mac-helper] disabled push-to-talk",
  );
  return result;
};

const syncPttRegistration = (): Promise<PttRegistrationResult> => {
  if (helperPttSync) return helperPttSync;

  const sync = (async (): Promise<PttRegistrationResult> => {
    let desired = desiredPttConfig();
    while (!pttConfigsEqual(helperPttConfig, desired)) {
      const result = await setHelperPttConfig(desired);
      if (!result.ok) return result;
      desired = desiredPttConfig();
    }
    return {
      ok: true,
      enabled: helperPttConfig.kind !== "none",
      config: helperPttConfig,
    };
  })();
  helperPttSync = sync;
  void sync.finally(() => {
    if (helperPttSync === sync) helperPttSync = null;
  });
  return sync;
};

const configurePttForOwner = async (
  webContents: WebContents,
  config: PttConfig,
): Promise<PttRegistrationResult> => {
  const normalized = normalizePttConfig(config);
  if (normalized.kind === "none") {
    removePttOwner(webContents.id);
  } else {
    addOrUpdatePttOwner(webContents, normalized);
  }
  const result = await syncPttRegistration();
  if (!result.ok && normalized.kind !== "none") {
    log.warn(`[mac-helper] failed to configure push-to-talk: ${result.reason}`);
    removePttOwner(webContents.id);
    void syncPttRegistration();
  }
  return result;
};

const sendPttEventToOwner = (event: PttEvent): void => {
  nativePttIsDown = event.state === "down";
  const ownerId = activePttOwnerId ?? newestPttOwnerId();
  const activeOwner = ownerId !== null ? pttOwners.get(ownerId) : null;
  const owner =
    activeOwner && !activeOwner.webContents.isDestroyed()
      ? activeOwner
      : pttOwners.get(newestPttOwnerId() ?? -1);
  if (!owner || owner.webContents.isDestroyed()) return;
  owner.webContents.send("vellum:ptt:state", event);
};

const sendSyntheticPttUpIfNeeded = (): void => {
  if (!nativePttIsDown) return;
  nativePttIsDown = false;
  sendPttEventToOwner({ state: "up" });
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

const restorePttRegistrationIfNeeded = async (): Promise<void> => {
  if (
    !restorePttAfterRestart ||
    restorePttInFlight ||
    helperPttConfig.kind !== "none" ||
    pttOwners.size === 0
  ) {
    return;
  }

  restorePttInFlight = true;
  const result = await syncPttRegistration();
  restorePttInFlight = false;
  if (result.ok) {
    restorePttAfterRestart = !result.enabled;
    if (result.enabled) {
      log.info("[mac-helper] restored push-to-talk after helper restart");
    }
  } else {
    log.warn(`[mac-helper] failed to restore push-to-talk: ${result.reason}`);
  }
};

const handleHelperState = (state: MacHelperState): void => {
  sendHelperStateToRenderers(state);
  if (state.status === "running") {
    void restoreHotkeyRegistrationIfNeeded();
    void restorePttRegistrationIfNeeded();
    return;
  }

  if (helperRegistered && hotkeyOwners.size > 0) {
    restoreHotkeyAfterRestart = true;
  }
  if (helperPttConfig.kind !== "none" && pttOwners.size > 0) {
    restorePttAfterRestart = true;
  }
  helperRegistered = false;
  helperPttConfig = NONE_PTT_CONFIG;
  // The partials session lived in the dead helper process; the renderer's
  // session simply continues without live text.
  dictationPartialsOwner = null;
  sendSyntheticHotkeyUpIfNeeded();
  sendSyntheticPttUpIfNeeded();
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
let unsubscribePttEvents: (() => void) | null = null;
let unsubscribeHelperState: (() => void) | null = null;
let unsubscribeDictationPartials: (() => void) | null = null;
let unsubscribePttConfigChanges: (() => void) | null = null;

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
  unsubscribePttEvents = client.onNotification(
    "ptt.event",
    PTT_EVENT_SCHEMA,
    (event) => {
      sendPttEventToOwner(event);
    },
  );
  unsubscribeDictationPartials = client.onNotification(
    "dictation.partial",
    DICTATION_PARTIAL_SCHEMA,
    (event) => {
      sendDictationPartialToOwner(event);
    },
  );
  unsubscribeHelperState = client.onState(handleHelperState);

  handle("vellum:helper:ping", z.tuple([]), () => ping());
  handle("vellum:helper:state:get", z.tuple([]), () => client.getState());
  handle("vellum:helper:restart", z.tuple([]), () => restartHelper());

  handle("vellum:ptt:getConfig", z.tuple([]), () => readPttConfig());
  handle("vellum:ptt:getConfigState", z.tuple([]), () => readPttConfigState());
  handle(
    "vellum:ptt:setConfig",
    z.tuple([PTT_CONFIG_SCHEMA]),
    ([config]) => writePttConfig(config),
  );
  handle(
    "vellum:ptt:configure",
    z.tuple([PTT_CONFIG_SCHEMA]),
    ([config], event) => configurePttForOwner(event.sender, config),
  );

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
    z.tuple([z.boolean()]),
    ([enable], event) => setDictationPartials(event.sender, enable),
  );

  app.on("before-quit", () => {
    client.shutdown({
      method: "hotkey.fnPushToTalk",
      params: { enable: false },
    });
  });

  unsubscribePttConfigChanges = onSettingChange("hotkeys", (next, previous) => {
    const nextConfig = parseStoredPttConfig(next?.[PTT_HOTKEY_SETTING_KEY]);
    const previousConfig = parseStoredPttConfig(
      previous?.[PTT_HOTKEY_SETTING_KEY],
    );
    if (pttConfigsEqual(nextConfig, previousConfig)) return;
    broadcastPttConfig();
  });
};

export const __resetForTesting = (): void => {
  installed = false;
  platformForTesting = null;
  supervisorOptionsForTesting = {};
  helperRegistered = false;
  helperRegistrationSync = null;
  restoreHotkeyAfterRestart = false;
  restoreHotkeyInFlight = false;
  pttIsDown = false;
  helperPttConfig = NONE_PTT_CONFIG;
  helperPttSync = null;
  restorePttAfterRestart = false;
  restorePttInFlight = false;
  nativePttIsDown = false;
  unsubscribeHotkeyEvents?.();
  unsubscribeHotkeyEvents = null;
  unsubscribePttEvents?.();
  unsubscribePttEvents = null;
  unsubscribeHelperState?.();
  unsubscribeHelperState = null;
  unsubscribeDictationPartials?.();
  unsubscribeDictationPartials = null;
  unsubscribePttConfigChanges?.();
  unsubscribePttConfigChanges = null;
  dictationPartialsOwner = null;
  for (const owner of hotkeyOwners.values()) owner.cleanup();
  hotkeyOwners.clear();
  activeHotkeyOwnerId = null;
  for (const owner of pttOwners.values()) owner.cleanup();
  pttOwners.clear();
  activePttOwnerId = null;
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
