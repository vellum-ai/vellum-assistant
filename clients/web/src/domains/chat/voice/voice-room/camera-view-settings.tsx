/**
 * Camera mode's view options: the corner button, and the compact panel it
 * opens.
 *
 * Two rows, and neither changes what the camera does. The frame-gate readout
 * shares the switch the Settings page writes, so one preference answers both
 * entry points; the kept-frame thumbnail is a voice preference of its own.
 * Hiding either one hides a drawing, and Live goes on sampling, sending and
 * recording every kept frame in the transcript.
 *
 * Anchored on every form factor, a touch phone included. The room is itself a
 * bottom sheet portaled into `#viewport-overlays`, and while the camera is
 * flush `useInertBehindSheet` marks that host's other children `inert`, so a
 * second sheet portaled beside the room lands inert and dead. The panel
 * portals into this component's own box inside the room instead, which is
 * below the level that sweep reaches.
 *
 * Over the feed the panel takes the shared over-media scrim rather than a
 * theme surface, for the reason `camera-mode-paint.ts` gives: what is behind
 * it is arbitrary video, so a token is as likely to vanish into the frame as
 * to read on it.
 */

import { useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";

import {
  Popover,
  PortalContainerProvider,
  Toggle,
  cn,
} from "@vellumai/design-library";

import { useTranslation } from "@/i18n";
import { useCameraGateHudAvailable } from "@/hooks/use-camera-gate-hud";
import { useCameraGateDebugStore } from "@/stores/camera-gate-debug-store";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

import { CAMERA_MEDIA_GLASS_CLASS, cameraModeStyle } from "./camera-mode-paint";
import { VoiceRoomControl } from "./voice-room-control";

/**
 * One row: what the switch shows, what it costs, and the switch.
 *
 * The copy carries its own color rather than the design library's label and
 * helper slots, which paint in theme tokens the feed behind this panel makes
 * unreadable.
 */
function ViewOptionRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-body-medium-default text-white">{title}</p>
        <p className="text-body-small-default text-white/65">{description}</p>
      </div>
      <div className="shrink-0 pt-0.5">
        <Toggle checked={checked} onChange={onChange} aria-label={title} />
      </div>
    </div>
  );
}

export function CameraViewSettings() {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  // The panel's portal target, held in state so the first render that has the
  // box also has somewhere to portal into.
  const [panelHost, setPanelHost] = useState<HTMLDivElement | null>(null);
  const hudAvailable = useCameraGateHudAvailable();
  const hudEnabled = useCameraGateDebugStore.use.hudEnabled();
  const setHudEnabled = useCameraGateDebugStore.use.setHudEnabled();
  const showKeptFrame = useVoicePrefsStore.use.showKeptFrame();
  const setShowKeptFrame = useVoicePrefsStore.use.setShowKeptFrame();

  return (
    <div ref={setPanelHost}>
      <PortalContainerProvider container={panelHost}>
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger asChild>
            <VoiceRoomControl
              label={t("cameraViewOptions.buttonAria")}
              bare
              surface="camera"
              pressed={open}
              data-testid="camera-view-settings"
              // Corner chrome is bare, so an open panel is the one state the
              // treatment has no fill for: it takes the hover fill instead.
              className={open ? "bg-black/60 text-white" : undefined}
            >
              <SlidersHorizontal className="size-5" />
            </VoiceRoomControl>
          </Popover.Trigger>
          <Popover.Content
            side="bottom"
            align="end"
            sideOffset={8}
            data-testid="camera-view-settings-panel"
            style={cameraModeStyle()}
            className={cn(
              "flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-lg p-3 shadow-lg",
              CAMERA_MEDIA_GLASS_CLASS,
            )}
          >
            <p className="text-label-small-default uppercase tracking-wide text-white/60">
              {t("cameraViewOptions.title")}
            </p>
            {hudAvailable ? (
              <ViewOptionRow
                title={t("cameraViewOptions.gateHudTitle")}
                description={t("cameraViewOptions.gateHudDescription")}
                checked={hudEnabled}
                onChange={setHudEnabled}
              />
            ) : null}
            <ViewOptionRow
              title={t("cameraViewOptions.keptFrameTitle")}
              description={t("cameraViewOptions.keptFrameDescription")}
              checked={showKeptFrame}
              onChange={setShowKeptFrame}
            />
          </Popover.Content>
        </Popover.Root>
      </PortalContainerProvider>
    </div>
  );
}
