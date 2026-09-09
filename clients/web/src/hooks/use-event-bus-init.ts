/**
 * React adapter for the bus's two non-React owners.
 *
 * Two effects, neither doing real work:
 *
 * 1. **Signal sources.** Wires each `runtime/event-sources/*` helper
 *    once at mount so DOM visibility, network online/offline,
 *    Capacitor app state, Capacitor deep links, Electron
 *    `powerMonitor`, Electron window attention, and Electron
 *    deep-link events flow into the bus. Both the DOM visibility source
 *    and the Electron attention source register unconditionally, and
 *    only one of them can fire on a given host: Electron disables the
 *    Page Visibility API and the attention bridge exists nowhere else.
 *    Both publish the lifecycle edge for the window leaving or
 *    returning to the screen, and the attention source adds
 *    `app.attention` for the narrower question of whether the user is
 *    watching.
 *    The lifecycle diagnostics
 *    recorder is attached in the same effect so those signals are
 *    captured for support bundles, and boot/resume performance
 *    telemetry alongside it (it reads the same `app.resume` /
 *    `sse.opened` edges, and registering here puts its subscription
 *    in place before the effect below attaches the SSE service).
 *
 * 2. **SSE service.** Calls `sseService.attach(assistantId)` when an
 *    assistant becomes active and the returned detach when it
 *    changes or unmounts. All connection lifecycle, dedup windows,
 *    and bounce policy live inside the service — paralleling
 *    `lifecycleService`.
 *
 * The daemon dedups SSE subscribers by `clientId`, so this hook MUST
 * be the only place that calls `sseService.attach`. Consumers
 * subscribe to `bus.sse.event` instead of opening their own SSE
 * handles.
 */
import { useEffect } from "react";

import { sseService } from "@/assistant/sse-service";
import { subscribeLifecycleDiagnostics } from "@/lib/lifecycle-diagnostics";
import { startBootTelemetry } from "@/lib/telemetry/boot-telemetry";
import { setupQueryFocusManager } from "@/lib/query-focus-manager";
import { subscribeSwitchTelemetry } from "@/lib/telemetry/switch-telemetry";
import { publishCapacitorAppStateSource } from "@/runtime/event-sources/capacitor-app-state";
import { publishCapacitorDeepLinksSource } from "@/runtime/event-sources/capacitor-deep-links";
import { publishShareInboxSource } from "@/runtime/share-inbox";
import { publishVisibilitySource } from "@/runtime/event-sources/dom-visibility";
import { publishElectronConnectivitySource } from "@/runtime/event-sources/electron-connectivity";
import { publishElectronDeepLinksSource } from "@/runtime/event-sources/electron-deep-links";
import { publishElectronDownloadsSource } from "@/runtime/event-sources/electron-downloads";
import { publishElectronPowerSource } from "@/runtime/event-sources/electron-power";
import { publishElectronWindowAttentionSource } from "@/runtime/event-sources/electron-window-attention";
import { publishWindowOnlineSource } from "@/runtime/event-sources/window-online";

interface UseEventBusInitParams {
  /** Resolved assistant id, or `null` when not yet loaded. */
  assistantId: string | null;
  /** `true` once the assistant lifecycle reports `kind === "active"`. */
  isAssistantActive: boolean;
}

export function useEventBusInit({
  assistantId,
  isAssistantActive,
}: UseEventBusInitParams): void {
  useEffect(() => {
    // Source helpers touch `document` / `window` at call time and
    // document their "caller guards under SSR/Node" contract in their
    // own JSDoc. `useEffect` already doesn't run during SSR render,
    // but the guard makes the contract explicit and survives any
    // future move to a non-React caller (e.g. invoking from a
    // module-level bootstrap). Keep aligned with CONVENTIONS.md's
    // "SSR/build-safe rendering" rule.
    if (typeof window === "undefined") {
      return;
    }
    // The post-resume request counter is deliberately absent: React runs
    // descendant effects before ancestor ones, so a counter registered here
    // would open its window after in-tree subscribers had already fired their
    // resume requests. It installs from `lib/api-interceptors.ts` module scope.
    const unsubscribers = [
      publishVisibilitySource(),
      publishWindowOnlineSource(),
      publishCapacitorAppStateSource(),
      publishCapacitorDeepLinksSource(),
      publishShareInboxSource(),
      publishElectronPowerSource(),
      publishElectronDeepLinksSource(),
      publishElectronDownloadsSource(),
      publishElectronConnectivitySource(),
      publishElectronWindowAttentionSource(),
      subscribeLifecycleDiagnostics(),
      startBootTelemetry(),
      subscribeSwitchTelemetry(),
      setupQueryFocusManager(),
    ];
    return () => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    };
  }, []);

  useEffect(() => {
    if (!assistantId || !isAssistantActive) {
      return;
    }
    return sseService.attach(assistantId);
  }, [assistantId, isAssistantActive]);
}
