import { useEffect, useState } from "react";

import { Toggle } from "@vellumai/design-library/components/toggle";

import { useTranslation } from "@/i18n";
import {
  getDeviceBool,
  setDeviceBool,
  watchDeviceSetting,
} from "@/utils/device-settings";

function asksBeforeStart(): boolean {
  return !getDeviceBool("voiceStartConfirmationSkipped", false);
}

/**
 * Whether the voice key's double tap asks on the companion before it starts a
 * call. On until "Always start" is chosen on that card, and this is the way
 * back. Follows a change made on the card while Settings is open.
 */
export function VoiceStartConfirmationToggle() {
  const { t } = useTranslation("settings");
  const [checked, setChecked] = useState(asksBeforeStart);

  useEffect(
    () =>
      watchDeviceSetting("voiceStartConfirmationSkipped", () => {
        setChecked(asksBeforeStart());
      }),
    [],
  );

  return (
    <Toggle
      checked={checked}
      onChange={(next: boolean) => {
        setChecked(next);
        setDeviceBool("voiceStartConfirmationSkipped", !next);
      }}
      label={t("voiceStartConfirmationToggle.label")}
      helperText={t("voiceStartConfirmationToggle.description")}
    />
  );
}
