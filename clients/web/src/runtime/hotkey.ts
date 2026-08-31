import type { PushToTalkActivator } from "@vellumai/ipc-contract";

import { isElectron, type HotkeyEvent } from "@/runtime/is-electron";

export type { HotkeyEvent };

export function supportsFnPushToTalk(): boolean {
  return (
    isElectron() &&
    typeof window.vellum?.helper?.hotkey?.fnPushToTalk === "function" &&
    typeof window.vellum?.helper?.hotkey?.onEvent === "function"
  );
}

export function supportsConfigurablePushToTalk(): boolean {
  return (
    isElectron() &&
    typeof window.vellum?.helper?.hotkey?.setPushToTalk === "function" &&
    typeof window.vellum?.helper?.hotkey?.onEvent === "function"
  );
}

export async function setNativePushToTalkActivator(
  activator: PushToTalkActivator | null,
): Promise<boolean> {
  if (!supportsConfigurablePushToTalk()) {
    return false;
  }
  try {
    const result =
      await window.vellum!.helper!.hotkey!.setPushToTalk!(activator);
    return result.ok;
  } catch {
    return false;
  }
}

export async function setFnPushToTalkEnabled(
  enable: boolean,
): Promise<boolean> {
  if (!supportsFnPushToTalk()) {
    return false;
  }
  try {
    const result = await window.vellum!.helper!.hotkey!.fnPushToTalk!(enable);
    return result.ok;
  } catch {
    return false;
  }
}

export function subscribeToHotkeyEvents(
  callback: (event: HotkeyEvent) => void,
): () => void {
  const subscribe = window.vellum?.helper?.hotkey?.onEvent;
  return subscribe ? subscribe(callback) : () => undefined;
}

export function subscribeToPushToTalkRegistration(
  callback: (active: boolean) => void,
): () => void {
  const subscribe = window.vellum?.helper?.hotkey?.onRegistrationChange;
  return subscribe ? subscribe(callback) : () => undefined;
}
