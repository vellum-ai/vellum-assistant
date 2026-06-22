import { publish } from "@/lib/event-bus";

/**
 * `window.online` / `window.offline` → `app.online` + `app.resume(signal: "online")`
 * / `app.offline`. The online event publishes BOTH a discrete
 * `app.online` (for consumers that only care about reachability flips)
 * AND an `app.resume` (for consumers that want a single "we're back"
 * channel covering visibility, app-state, and online).
 *
 * Browser-only; same SSR guard as `publishVisibilitySource`.
 */
export function publishWindowOnlineSource(): () => void {
  const onOnline = () => {
    publish("app.online", {});
    publish("app.resume", { signal: "online" });
  };
  const onOffline = () => {
    publish("app.offline", {});
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}
