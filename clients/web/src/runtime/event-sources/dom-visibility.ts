import { publish } from "@/lib/event-bus";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";
import { isClientAttended } from "@/runtime/window-attention";
import { publishLifecycleEdge } from "@/runtime/event-sources/lifecycle-edge";

/**
 * `document.visibilitychange` → `app.resume(signal: "visibility")` on
 * visible, `app.hidden(signal: "visibility")` on hidden. The cross-domain
 * bus is the consumer; SSE policy (in `assistant/sse-service.ts`)
 * keeps desktop streams connected while hidden and recovers on resume.
 *
 * The Capacitor iOS shell fires `appStateChange` for the same physical
 * edge, which the bus sees through `publishCapacitorAppStateSource` with
 * `signal: "app_state"`. Both go through
 * `runtime/event-sources/lifecycle-edge.ts`, which publishes the edge once.
 *
 * Browser-only; the caller is responsible for not invoking this in an
 * environment without `document` (SSR / Node). `useEventBusInit` guards
 * with `typeof window === "undefined"`.
 */
export function publishVisibilitySource(): () => void {
  const handler = () => {
    if (document.visibilityState === "hidden") {
      publishLifecycleEdge("hidden", "visibility");
    } else {
      publishLifecycleEdge("resume", "visibility");
    }
  };
  const publishAttention = () => {
    publish("app.attention", { attended: isClientAttended() });
  };
  const browserAttention = !isElectron() && !isNativePlatform();
  document.addEventListener("visibilitychange", handler);
  if (browserAttention) {
    window.addEventListener("focus", publishAttention);
    window.addEventListener("blur", publishAttention);
  }
  return () => {
    document.removeEventListener("visibilitychange", handler);
    if (browserAttention) {
      window.removeEventListener("focus", publishAttention);
      window.removeEventListener("blur", publishAttention);
    }
  };
}
