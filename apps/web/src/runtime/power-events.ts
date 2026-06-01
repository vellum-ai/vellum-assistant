import { isElectron } from "@/runtime/is-electron";

/**
 * Per-capability wrapper for the Electron host's system power-state
 * bridge — sleep, wake, screen lock/unlock, idle-recover. Matches the
 * shape in `dock.ts` and `app-info.ts`: feature code never touches
 * `window.vellum.*` directly, and the cross-platform branch lives here.
 *
 * Off Electron (web build, Capacitor iOS): `subscribeToPowerEvents`
 * is a no-op that returns an unsubscribe-noop. Web has its own
 * resume-detection signals (visibility, online, app-state) and they
 * already feed the bus via `use-event-bus-init`; the system-level
 * power signal is Electron-specific.
 *
 * The bus integration in `use-event-bus-init` calls this once at
 * mount, narrowing the kind into `power.suspend` / `power.resume`
 * / `power.lock` / `power.unlock` / `power.active` events on the
 * shared bus. Domain consumers (SSE reconnect, auth refresh,
 * reachability probe) subscribe to bus events — NOT to this
 * wrapper directly — so the same subscriber code works on web,
 * iOS, and Electron.
 */

export type PowerEventKind =
  | "suspend"
  | "resume"
  | "lock"
  | "unlock"
  | "active";

export interface PowerEvent {
  kind: PowerEventKind;
}

export function subscribeToPowerEvents(
  callback: (event: PowerEvent) => void,
): () => void {
  if (!isElectron()) return () => undefined;
  return window.vellum?.power.onEvent(callback) ?? (() => undefined);
}
