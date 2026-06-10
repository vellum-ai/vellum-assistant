import {
  FN_PTT_ACTIVATOR,
  LS_PTT_ACTIVATION_KEY,
  NONE_PTT_ACTIVATOR,
  parseActivator,
  serializeActivator,
  type PTTActivator,
} from "@/utils/ptt-activator";
import {
  getLocalSetting,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";
import {
  isElectron,
  type HotkeyEvent,
  type PttConfig,
  type PttEvent,
  type PttRegistrationResult,
} from "@/runtime/is-electron";

export type { HotkeyEvent, PttEvent, PttRegistrationResult };

function pttBridge() {
  return isElectron() ? window.vellum?.ptt : undefined;
}

export function supportsNativePushToTalk(): boolean {
  const bridge = pttBridge();
  return (
    !!bridge &&
    typeof bridge.getConfig === "function" &&
    typeof bridge.setConfig === "function" &&
    typeof bridge.configure === "function" &&
    typeof bridge.on === "function"
  );
}

export function canConfigureFnPushToTalk(): boolean {
  return supportsNativePushToTalk();
}

export function getDefaultPushToTalkConfig(): PTTActivator {
  return supportsNativePushToTalk() ? FN_PTT_ACTIVATOR : NONE_PTT_ACTIVATOR;
}

export function getLocalPushToTalkConfig(): PTTActivator {
  const raw = getLocalSetting(LS_PTT_ACTIVATION_KEY, "");
  return raw
    ? parseActivator(raw, { preserveFunction: supportsNativePushToTalk() })
    : getDefaultPushToTalkConfig();
}

export async function getPushToTalkConfig(): Promise<PTTActivator> {
  const bridge = pttBridge();
  if (supportsNativePushToTalk() && bridge) {
    return parseActivator(await bridge.getConfig(), { preserveFunction: true });
  }
  return getLocalPushToTalkConfig();
}

export async function setPushToTalkConfig(
  config: PTTActivator,
): Promise<PTTActivator> {
  const bridge = pttBridge();
  if (supportsNativePushToTalk() && bridge) {
    return parseActivator(await bridge.setConfig(config as PttConfig), {
      preserveFunction: true,
    });
  }
  setLocalSetting(LS_PTT_ACTIVATION_KEY, serializeActivator(config));
  return config;
}

export async function configureNativePushToTalk(
  config: PTTActivator,
): Promise<boolean> {
  const bridge = pttBridge();
  if (!supportsNativePushToTalk() || !bridge) return false;
  try {
    const result = await bridge.configure(config as PttConfig);
    return result.ok;
  } catch {
    return false;
  }
}

export function onPushToTalkConfigChange(
  callback: (config: PTTActivator) => void,
): () => void {
  const bridge = pttBridge();
  if (supportsNativePushToTalk() && bridge?.onConfigChange) {
    return bridge.onConfigChange((config) => {
      callback(parseActivator(config, { preserveFunction: true }));
    });
  }
  return watchSetting(LS_PTT_ACTIVATION_KEY, () => {
    callback(getLocalPushToTalkConfig());
  });
}

export function subscribeToNativePushToTalkEvents(
  callback: (event: PttEvent) => void,
): () => void {
  const bridge = pttBridge();
  if (!supportsNativePushToTalk() || !bridge) return () => undefined;
  return bridge.on(callback);
}

// Legacy Fn-only wrapper names kept for older callers/tests while the app
// migrates to the generic PTT bridge.
export function supportsFnPushToTalk(): boolean {
  return supportsNativePushToTalk();
}

export async function setFnPushToTalkEnabled(
  enable: boolean,
): Promise<boolean> {
  return configureNativePushToTalk(
    enable ? FN_PTT_ACTIVATOR : NONE_PTT_ACTIVATOR,
  );
}

export function subscribeToHotkeyEvents(
  callback: (event: HotkeyEvent) => void,
): () => void {
  return subscribeToNativePushToTalkEvents((event) => {
    callback({ kind: "fnPushToTalk", state: event.state });
  });
}
