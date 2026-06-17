import { isElectron } from "@/runtime/is-electron";

export async function getLaunchAtLogin(): Promise<boolean> {
  if (!isElectron()) return false;
  const bridge = window.vellum;
  if (!bridge?.launchAtLogin) return false;
  return bridge.launchAtLogin.get();
}

export async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  if (!isElectron()) return;
  const bridge = window.vellum;
  if (!bridge?.launchAtLogin) return;
  await bridge.launchAtLogin.set(enabled);
}
