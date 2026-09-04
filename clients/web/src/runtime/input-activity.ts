import { isElectron } from "@/runtime/is-electron";

/**
 * Whether the user is typing or clicking anywhere on the host, reported
 * without which keys or where. Off Electron nothing is reported and the watch
 * is refused, which callers read as "no evidence either way".
 */
export async function setInputActivityWatch(enable: boolean): Promise<boolean> {
  const set = window.vellum?.helper?.input?.setActivityWatch;
  if (!isElectron() || typeof set !== "function") {
    return false;
  }
  try {
    return await set(enable);
  } catch {
    return false;
  }
}

export function subscribeToInputActivity(callback: () => void): () => void {
  const subscribe = window.vellum?.helper?.input?.onActivity;
  return subscribe ? subscribe(callback) : () => undefined;
}
