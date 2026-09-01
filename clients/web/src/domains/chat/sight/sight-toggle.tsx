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
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  isVisionModeOn,
  useVisionModeVariant,
} from "@/hooks/use-vision-mode-flag";
import { useTranslation } from "@/i18n";

export interface SightToggleProps {
  /**
   * Whether an image attached to this message would survive the turn. False on
   * an assistant older than the image-fallback plugin whose active profile has
   * no vision, where the provider rejects the image and takes the whole turn
   * down with it. Resolved once by the chat route, so this control and the
   * drop/pick path read the same answer.
   */
  imageAttachmentsAllowed: boolean;
}

export function SightToggle({ imageAttachmentsAllowed }: SightToggleProps) {
  const { t } = useTranslation("chat");
  const variant = useVisionModeVariant();
  const status = useSightStore.use.status();
  const start = useSightStore.use.start();
  const stop = useSightStore.use.stop();
  // A call owns the one webcam while it runs, and raises a viewfinder of its
  // own to prove it. See the sight store's release triggers.
  const callIsLive = isLiveVoiceSessionActive(useLiveVoiceStore.use.state());

  // Hidden rather than degraded where an image cannot be sent, per the
  // backwards-compat discipline: a camera whose frames were silently dropped on
  // the way out would read as broken. Only the entry point is gated, since the
  // tile renders off the camera's own status and carries its own close control,
  // so a camera already running is never stranded behind a vanished toggle.
  if (!isVisionModeOn(variant) || !imageAttachmentsAllowed) {
    return null;
  }

  const engaged = status !== "off";
  // Disabled rather than hidden, and the label says why: a control that
  // vanishes when a call starts reads as a bug, and the reason it is
  // unavailable is exactly the thing the user can act on (end the call, or use
  // the room's own viewfinder).
  const label = callIsLive
    ? t("sightToggle.busyInCall")
    : engaged
      ? t("sightToggle.turnOff")
      : t("sightToggle.turnOn");

  return (
    <Button
      variant="ghost"
      iconOnly={engaged ? <Eye /> : <EyeOff />}
      active={engaged}
      aria-pressed={engaged}
      disabled={callIsLive}
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
