import type { EventBusPublisher } from "@/stores/event-bus-store";

/**
 * `window.online` / `window.offline` → `app.online` + `app.resume(signal: "online")`
 * / `app.offline`. The online event publishes BOTH a discrete
 * `app.online` (for consumers that only care about reachability flips)
 * AND an `app.resume` (for consumers that want a single "we're back"
 * channel covering visibility, app-state, and online).
 *
 * Browser-only; same SSR guard as `publishVisibilitySource`.
 */
export function publishWindowOnlineSource(
  bus: EventBusPublisher,
): () => void {
  const onOnline = () => {
    bus.publish("app.online", {});
    bus.publish("app.resume", { signal: "online" });
  };
  const onOffline = () => {
    bus.publish("app.offline", {});
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}
