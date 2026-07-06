import { captureError } from "@/lib/sentry/capture-error";
import type { PluginListenerHandle } from "@capacitor/core";

import { isNativePlatform } from "@/runtime/native-auth";

/**
 * Shared subscription scaffold for Capacitor plugin event listeners.
 * Owns the pieces every native listener source needs:
 *
 * - The `isNativePlatform()` guard — off Capacitor iOS this returns a
 *   no-op unsubscribe without ever invoking `subscribe` (so the plugin
 *   is never loaded).
 * - The unsubscribe-before-registration race: `subscribe()` resolves
 *   asynchronously (lazy plugin import), so an unsubscribe that runs
 *   first sets the internal `cancelled` flag and the resolution path
 *   removes the just-registered listener instead of leaking it.
 * - Failure reporting: a rejected `subscribe()` is captured under
 *   `errorContext` at warning level instead of surfacing as an
 *   unhandled rejection.
 *
 * `subscribe` must lazy-import the plugin and call `addListener`
 * inline, per CAPACITOR.md's "lazy-import rule" — the plugin Proxy
 * must never cross a Promise-resolution context, so it stays inside
 * the caller's closure and only the listener handle escapes:
 *
 * ```ts
 * subscribeCapacitorListener("my_context", async () => {
 *   const { App } = await import("@capacitor/app");
 *   return App.addListener("appStateChange", handler);
 * });
 * ```
 */
export function subscribeCapacitorListener(
  errorContext: string,
  subscribe: () => Promise<PluginListenerHandle>,
): () => void {
  if (!isNativePlatform()) {
    return () => undefined;
  }

  let handle: PluginListenerHandle | null = null;
  let cancelled = false;

  subscribe()
    .then((registered) => {
      if (cancelled) {
        void registered.remove();
        return;
      }
      handle = registered;
    })
    .catch((err) => {
      captureError(err, { context: errorContext, level: "warning" });
    });

  return () => {
    cancelled = true;
    void handle?.remove();
  };
}
