import {
  isElectron,
  type HotkeyEvent,
  type HotkeyModifier,
} from "@/runtime/is-electron";

export type { HotkeyEvent, HotkeyModifier };

export function canConfigureFnPushToTalk(): boolean {
  return isElectron();
}

export function supportsFnPushToTalk(): boolean {
  return (
    isElectron() &&
    (typeof window.vellum?.helper?.hotkey?.pushToTalk === "function" ||
      typeof window.vellum?.helper?.hotkey?.fnPushToTalk === "function") &&
    typeof window.vellum?.helper?.hotkey?.onEvent === "function"
  );
}

export function supportsNativePushToTalk(): boolean {
  return supportsFnPushToTalk();
}

function isFnOnly(modifiers: readonly HotkeyModifier[]): boolean {
  return modifiers.length === 1 && modifiers[0] === "function";
}

export async function setNativePushToTalkEnabled(
  enable: boolean,
  modifiers: readonly HotkeyModifier[],
): Promise<boolean> {
  if (!supportsNativePushToTalk()) return false;
  try {
    const hotkey = window.vellum!.helper!.hotkey!;
    const pushToTalk = hotkey.pushToTalk;
    const result = pushToTalk
      ? await pushToTalk(enable, [...modifiers])
      : !enable || isFnOnly(modifiers)
        ? await hotkey.fnPushToTalk(enable)
        : { ok: false as const, reason: "native modifier PTT is unavailable" };
    return result.ok;
  } catch {
    return false;
  }
}

export async function setFnPushToTalkEnabled(
  enable: boolean,
): Promise<boolean> {
  return setNativePushToTalkEnabled(enable, ["function"]);
}

export function subscribeToHotkeyEvents(
  callback: (event: HotkeyEvent) => void,
): () => void {
  if (!supportsFnPushToTalk()) return () => undefined;
  return window.vellum!.helper!.hotkey!.onEvent(callback);
}
