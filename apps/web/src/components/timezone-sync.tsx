/**
 * Headless background sync of the live effective timezone into the
 * assistant daemon config at `config.ui.detectedTimezone`.
 *
 * `useEffectiveTimezone()` re-reads the zone on window focus,
 * visibility, and device-setting override changes, so this component
 * keeps the daemon's *detected* zone fresh for background grounding
 * (memory retrospective, scheduling) that has no per-turn
 * `clientTimezone`. Per the backend resolver cascade this only ever
 * writes `detectedTimezone` — `config.ui.userTimezone` is owned by the
 * settings UI and a manual override still wins.
 *
 * Mounted once in `RootLayout` (behind `authMiddleware`), so it lives
 * for the whole authenticated session and never renders on public
 * `/account` routes. The active assistant id comes from
 * `useAssistantSelectionStore`, which the lifecycle populates once a
 * logged-in assistant resolves; until then the id is null and we skip.
 *
 * A sync only advances `lastSyncedRef` once the PATCH *succeeds*, so a
 * failed sync (e.g. resumed-after-offline) leaves the key "unsynced"
 * and is retried on the next `app.resume` bus signal or window focus —
 * even when the effective zone string is unchanged. A successful prior
 * sync makes those triggers a no-op, preserving the no-redundant-PATCH
 * guarantee.
 *
 * Renders `null` and is silent on error — a failed background sync must
 * never surface a toast.
 */
import { useCallback, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";

import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { client } from "@/generated/api/client.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { captureError } from "@/lib/sentry/capture-error";
import { getEffectiveTimezone } from "@/utils/effective-timezone";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

export function TimezoneSync(): null {
  // Reactive zone drives the effect below; resume/focus handlers re-read
  // the *current* zone via `getEffectiveTimezone()` to avoid stale closures.
  const tz = useEffectiveTimezone();
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();

  const { mutateAsync: patchDetectedTimezone } = useMutation({
    mutationFn: async (vars: { assistantId: string; tz: string }) => {
      const { data } = await client.patch<Record<string, unknown>, unknown, true>({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: vars.assistantId },
        body: { ui: { detectedTimezone: vars.tz } },
        throwOnError: true,
      });
      return data;
    },
  });

  // `${assistantId}:${tz}` of the last *successful* sync, to avoid
  // redundant PATCHes when nothing has changed. Keyed on the assistant
  // too so switching assistants re-syncs even when the zone is identical.
  // Only advanced on success, so a failed sync stays "unsynced" and is
  // retried on the next resume/focus.
  const lastSyncedRef = useRef<string | null>(null);

  // Hold the live assistant id so resume/focus handlers (which capture
  // `trySync` once) always target the current assistant.
  const assistantIdRef = useRef(assistantId);
  assistantIdRef.current = assistantId;

  const trySync = useCallback(() => {
    const currentAssistantId = assistantIdRef.current;
    const currentTz = getEffectiveTimezone();
    if (!currentAssistantId || !currentTz) return;

    const key = `${currentAssistantId}:${currentTz}`;
    if (lastSyncedRef.current === key) return;

    // Fire-and-forget: background sync, silent on error. Only record the
    // key on success so a transient failure is retried on next trigger.
    patchDetectedTimezone({ assistantId: currentAssistantId, tz: currentTz })
      .then(() => {
        lastSyncedRef.current = key;
      })
      .catch((error) => {
        captureError(error, { context: "timezone-sync-detected" });
      });
  }, [patchDetectedTimezone]);

  // Reactive path: zone or assistant change.
  useEffect(() => {
    trySync();
  }, [tz, assistantId, trySync]);

  // Resume/focus path: retry a previously failed sync even when the zone
  // string is unchanged. A successful prior sync makes this a no-op.
  useBusSubscription("app.resume", trySync);
  useEffect(() => {
    window.addEventListener("focus", trySync);
    return () => window.removeEventListener("focus", trySync);
  }, [trySync]);

  return null;
}
