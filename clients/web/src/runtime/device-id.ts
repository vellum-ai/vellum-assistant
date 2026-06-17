import { isElectron } from "@/runtime/is-electron";

let cached: string | null | undefined;

export function getDeviceId(): string | null {
  if (!isElectron()) return null;
  if (cached === undefined) {
    cached =
      (window as unknown as { __VELLUM_CONFIG__?: { deviceId?: string } })
        .__VELLUM_CONFIG__?.deviceId ?? null;
  }
  return cached;
}
