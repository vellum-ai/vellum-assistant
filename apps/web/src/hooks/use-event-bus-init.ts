/**
 * React adapter for the bus's two non-React owners.
 *
 * Two effects, neither doing real work:
 *
 * 1. **Signal sources.** Wires each `runtime/event-sources/*` helper
 *    once at mount so DOM visibility, network online/offline,
 *    Capacitor app state, Electron `powerMonitor`, and Electron
 *    deep-link events flow into the bus.
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
import { publishCapacitorAppStateSource } from "@/runtime/event-sources/capacitor-app-state";
import { publishVisibilitySource } from "@/runtime/event-sources/dom-visibility";
import { publishElectronDeepLinksSource } from "@/runtime/event-sources/electron-deep-links";
import { publishElectronPowerSource } from "@/runtime/event-sources/electron-power";
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
    if (typeof window === "undefined") return;
    const unsubscribers = [
      publishVisibilitySource(),
      publishWindowOnlineSource(),
      publishCapacitorAppStateSource(),
      publishElectronPowerSource(),
      publishElectronDeepLinksSource(),
    ];
    return () => {
      for (const unsub of unsubscribers) unsub();
    };
  }, []);

  useEffect(() => {
    if (!assistantId || !isAssistantActive) return;
    return sseService.attach(assistantId);
  }, [assistantId, isAssistantActive]);
}
