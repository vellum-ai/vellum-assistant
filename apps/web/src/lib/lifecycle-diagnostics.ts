/**
 * Records app-lifecycle and network bus signals into the durable
 * lifecycle diagnostics ring.
 *
 * These signals (`app.resume` / `app.hidden`, `app.online` /
 * `app.offline`, `power.*`) drive the SSE bounce-and-reconnect policy in
 * `assistant/sse-service.ts`. Without recording them, a support bundle
 * cannot answer the question a "stale content after the tab regains
 * focus" report hinges on: did any resume / visibility / network signal
 * actually fire during the gap, or did the connection silently die with
 * nothing to wake it? Recording at the bus (rather than at each
 * `runtime/event-sources/*` producer) captures exactly what reached
 * consumers, on a single channel, and keeps the producers pure.
 *
 * A consumer, not a producer — wired once at mount alongside the signal
 * sources in `hooks/use-event-bus-init.ts`.
 */

import { recordLifecycleDiagnostic } from "@/lib/diagnostics";
import { subscribe, type BusEventName } from "@/lib/event-bus";

const LIFECYCLE_EVENTS = [
  "app.resume",
  "app.hidden",
  "app.online",
  "app.offline",
  "power.suspend",
  "power.resume",
  "power.lock",
  "power.unlock",
  "power.active",
] as const satisfies readonly BusEventName[];

/**
 * Subscribe the lifecycle recorder to the bus. Returns an unsubscribe
 * that detaches every handler.
 */
export function subscribeLifecycleDiagnostics(): () => void {
  const unsubscribers = LIFECYCLE_EVENTS.map((event) =>
    subscribe(event, (payload) => {
      recordLifecycleDiagnostic(event, { ...payload });
    }),
  );
  return () => {
    for (const unsub of unsubscribers) unsub();
  };
}
