import { isElectron, type HotkeyEvent } from "@/runtime/is-electron";

export type { HotkeyEvent };

export function canConfigureFnPushToTalk(): boolean {
  return isElectron();
}

export function supportsFnPushToTalk(): boolean {
  return (
    isElectron() &&
    typeof window.vellum?.helper?.hotkey?.fnPushToTalk === "function" &&
    typeof window.vellum?.helper?.hotkey?.onEvent === "function"
  );
}

export async function setFnPushToTalkEnabled(
  enable: boolean,
): Promise<boolean> {
  if (!supportsFnPushToTalk()) return false;
  try {
    const result = await window.vellum!.helper!.hotkey!.fnPushToTalk(enable);
    return result.ok;
  } catch {
    return false;
  }
}

export function subscribeToHotkeyEvents(
  callback: (event: HotkeyEvent) => void,
): () => void {
  if (!supportsFnPushToTalk()) return () => undefined;
  return window.vellum!.helper!.hotkey!.onEvent(callback);
}
