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
 * Renders `null` and is silent on error — a failed background sync must
 * never surface a toast.
 */
import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";

import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { client } from "@/generated/api/client.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

export function TimezoneSync(): null {
  const tz = useEffectiveTimezone();
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();

  const { mutate: patchDetectedTimezone } = useMutation({
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

  // `${assistantId}:${tz}` we last kicked off a sync for, to avoid
  // redundant PATCHes and render loops when neither has changed. Keyed
  // on the assistant too so switching assistants re-syncs even when the
  // zone is identical.
  const lastSyncedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!tz || !assistantId) return;
    const key = `${assistantId}:${tz}`;
    if (lastSyncedRef.current === key) return;
    lastSyncedRef.current = key;
    // Fire-and-forget: background sync, silent on error.
    patchDetectedTimezone(
      { assistantId, tz },
      {
        onError: (error) => {
          // Allow a retry of this zone on the next focus/change.
          if (lastSyncedRef.current === key) lastSyncedRef.current = null;
          captureError(error, { context: "timezone-sync-detected" });
        },
      },
    );
  }, [tz, assistantId, patchDetectedTimezone]);

  return null;
}
