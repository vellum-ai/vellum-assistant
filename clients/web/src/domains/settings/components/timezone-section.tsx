import { useEffect, useRef, useState } from "react";

import { TimezonePicker } from "@/domains/settings/components/timezone-picker";
import { client } from "@/generated/api/client.gen";
import { useTranslation } from "@/i18n";
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
  const { t } = useTranslation("settings");
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const [timezone, setTimezone] = useState<string>(() =>
    getDeviceSetting("timezone", ""),
  );

  const assistantIdRef = useRef(assistantId);
  useEffect(() => {
    assistantIdRef.current = assistantId;
  }, [assistantId]);

  const inFlightRef = useRef(false);
  const pendingValueRef = useRef<string | null>(null);
  const syncOverrideRef = useRef<(value: string) => void>(() => {});

  const syncOverride = (value: string) => {
    if (inFlightRef.current) {
      pendingValueRef.current = value;
      return;
    }
    const currentAssistantId = assistantIdRef.current;
    if (!currentAssistantId) {
      pendingValueRef.current = null;
      return;
    }
    inFlightRef.current = true;
    pendingValueRef.current = null;
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

  useEffect(() => {
    syncOverrideRef.current = syncOverride;
  });

  const handleChange = (value: string) => {
    setTimezone(value);
    setDeviceSetting("timezone", value);
    syncOverride(value);
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-title-small text-[var(--content-emphasised)]">
        {t("timezoneSection.title")}
      </h3>
      <p className="text-body-medium-default text-[var(--content-tertiary)]">
        {t("timezoneSection.description")}
      </p>
      <div className="mt-1">
        <TimezonePicker value={timezone} onChange={handleChange} />
      </div>
    </section>
  );
}
