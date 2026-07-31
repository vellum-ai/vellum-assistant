import { publish } from "@/lib/event-bus";

/**
 * `document.visibilitychange` → `app.resume(signal: "visibility")` on
 * visible, `app.hidden(signal: "visibility")` on hidden. The cross-domain
 * bus is the consumer; SSE policy (in `assistant/sse-service.ts`)
 * teardowns on hidden and reopens on resume.
 *
 * The Capacitor iOS shell fires `appStateChange` too, which the bus
 * sees through `publishCapacitorAppStateSource` with `signal: "app_state"`.
 * Consumers that want to dedup between the two collapse them on their
 * own — the bus delivers every signal it sees.
 *
 * Browser-only; the caller is responsible for not invoking this in an
 * environment without `document` (SSR / Node). `useEventBusInit` guards
 * with `typeof window === "undefined"`.
 */
export function publishVisibilitySource(): () => void {
  const handler = () => {
    if (document.visibilityState === "hidden") {
      publish("app.hidden", { signal: "visibility" });
    } else {
      publish("app.resume", { signal: "visibility" });
    }
  };
  document.addEventListener("visibilitychange", handler);
  return () => {
    document.removeEventListener("visibilitychange", handler);
  };
}
