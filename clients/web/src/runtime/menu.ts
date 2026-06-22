import { isElectron } from "@/runtime/is-electron";

export async function setMenuPlatformSession(has: boolean): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.menu.setPlatformSession(has);
}
