import { useEffect, useRef, useState } from "react";

import { TimezonePicker } from "@/domains/settings/components/timezone-picker";
import { client } from "@/generated/api/client.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { getDeviceSetting, setDeviceSetting } from "@/utils/device-settings";

/**
 * Timezone preference editor, rendered as a section inside the Profile card.
 *
 * The chosen zone is written to two places: the local device setting (the
 * reactive source for `useEffectiveTimezone`) and the assistant's
 * `ui.userTimezone` config override on the server.
 */
export function TimezoneSection() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const [timezone, setTimezone] = useState<string>(() =>
    getDeviceSetting("timezone", ""),
  );

  // Hold the live assistant id so a PATCH that fires (or drains) after the
  // user switches assistants always targets the *current* one. Assigned in an
  // effect (never during render) to avoid mutating a ref while rendering.
  const assistantIdRef = useRef(assistantId);
  useEffect(() => {
    assistantIdRef.current = assistantId;
  }, [assistantId]);

  // Serialize the `ui.userTimezone` override PATCH (last-writer-wins): at most
  // one in flight. A change while one is in flight only records the latest
  // desired value; the in-flight PATCH drains to it on settle, so overlapping
  // rapid changes can never land out of order and leave a stale override.
  const inFlightRef = useRef(false);
  const pendingValueRef = useRef<string | null>(null);

  // Stable indirection so the `.finally` drain can call the latest
  // `syncOverride` without referencing `const syncOverride` inside its own
  // initializer (which would be a temporal-dead-zone access).
  const syncOverrideRef = useRef<(value: string) => void>(() => {});

  const syncOverride = (value: string) => {
    if (inFlightRef.current) {
      pendingValueRef.current = value;
      return;
    }
    // Re-read the current active assistant at fire time so a queued write after
    // an assistant switch targets whatever assistant is selected now, not the
    // one active when the change was first requested.
    const currentAssistantId = assistantIdRef.current;
    if (!currentAssistantId) {
      // No assistant to target: drop this write and clear queued state so the
      // serializer can't deadlock.
      pendingValueRef.current = null;
      return;
    }
    inFlightRef.current = true;
    pendingValueRef.current = null;
    // `value` is the chosen IANA zone, or "" when auto is selected (the schema
    // documents "" clears the setting). Silent on error.
    client
      .patch<Record<string, unknown>, unknown, true>({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: currentAssistantId },
        body: { ui: { userTimezone: value } },
        throwOnError: true,
      })
      .catch((error) => {
        captureError(error, { context: "settings-timezone-override" });
      })
      .finally(() => {
        inFlightRef.current = false;
        const pending = pendingValueRef.current;
        pendingValueRef.current = null;
        if (pending !== null) {
          syncOverrideRef.current(pending);
        }
      });
  };

  // Keep the drain indirection pointed at the latest `syncOverride`. Assigned
  // in an effect (never during render) for the same "no refs during render"
  // reason as `assistantIdRef`.
  useEffect(() => {
    syncOverrideRef.current = syncOverride;
  });

  const handleChange = (value: string) => {
    // Local source of truth for the reactive `useEffectiveTimezone` hook.
    setTimezone(value);
    setDeviceSetting("timezone", value);

    // Explicit user action: write the manual override to the authoritative
    // `ui.userTimezone` cascade tier. Fire-and-forget; never block the local
    // setting on the network write, and never throw out of handleChange.
    // `syncOverride` self-guards on a missing assistant id.
    syncOverride(value);
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-title-small text-[var(--content-emphasised)]">
        Timezone
      </h3>
      <p className="text-body-medium-default text-[var(--content-tertiary)]">
        Used when displaying times and scheduling reminders.
      </p>
      <div className="mt-1">
        <TimezonePicker value={timezone} onChange={handleChange} />
      </div>
    </section>
  );
}
