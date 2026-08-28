/**
 * The composer's Eyes control: one press opens the camera and raises the
 * viewfinder tile, the next gives the camera back.
 *
 * Sits beside the paperclip and wears the same resting tone, so the action row
 * reads as one set. It is also the feature's only entry point, which is why the
 * `vision-mode` flag is checked here and nowhere else.
 */

import { Eye, EyeOff } from "lucide-react";
import { Button } from "@vellumai/design-library";

import { useSightStore } from "@/domains/chat/sight/sight-store";
import {
  isVisionModeOn,
  useVisionModeVariant,
} from "@/hooks/use-vision-mode-flag";
import { useTranslation } from "@/i18n";

export function SightToggle() {
  const { t } = useTranslation("chat");
  const variant = useVisionModeVariant();
  const status = useSightStore.use.status();
  const start = useSightStore.use.start();
  const stop = useSightStore.use.stop();

  // Only the entry point is gated: the tile keeps rendering off the camera's
  // own status, so a flag turned off mid-session still leaves its close button
  // reachable rather than stranding a live camera behind a vanished control.
  if (!isVisionModeOn(variant)) {
    return null;
  }

  const engaged = status !== "off";
  const label = engaged ? t("sightToggle.turnOff") : t("sightToggle.turnOn");

  return (
    <Button
      variant="ghost"
      iconOnly={engaged ? <Eye /> : <EyeOff />}
      active={engaged}
      aria-pressed={engaged}
      onClick={() => {
        if (engaged) {
          stop();
          return;
        }
        void start();
      }}
      aria-label={label}
      title={label}
      // Tertiary resting tone, matching the composer action row's other icons.
      className="[--vbtn-fg:var(--content-tertiary)] touch-mobile:[--vbtn-fg:var(--content-tertiary)]"
    />
  );
}
