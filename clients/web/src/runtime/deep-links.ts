import { isElectron } from "@/runtime/is-electron";

/**
 * Per-capability wrapper for the Electron host's deep-link bridge —
 * `vellum://` and `vellum-assistant://` URL schemes routed in by
 * Launch Services. Same shape as `power-events.ts`: no-op off
 * Electron (web build, Capacitor iOS), publishes into the event bus
 * via `use-event-bus-init` once it lands, and domain consumers
 * subscribe via the bus — never via this wrapper directly.
 *
 * Two surfaces because deep links can arrive BEFORE the renderer
 * exists (the OS launches the app via a `vellum://` click):
 *
 *   - `drainPendingDeepLinks()` — returns the buffer of links
 *     that arrived during main-process startup, before the renderer
 *     had a chance to subscribe.
 *   - `subscribeToDeepLinks(callback)` — subscribes to LIVE links
 *     (post-renderer-ready). Subscribe BEFORE draining to cover the
 *     narrow race where a link arrives in flight.
 */

export type DeepLink =
  | { kind: "send"; message: string }
  | { kind: "openThread"; threadId: string }
  | { kind: "unknown"; url: string };

export async function drainPendingDeepLinks(): Promise<DeepLink[]> {
  if (!isElectron()) return [];
  return (await window.vellum?.deepLinks.drain()) ?? [];
}

export function subscribeToDeepLinks(
  callback: (link: DeepLink) => void,
): () => void {
  if (!isElectron()) return () => undefined;
  return window.vellum?.deepLinks.onLink(callback) ?? (() => undefined);
}
