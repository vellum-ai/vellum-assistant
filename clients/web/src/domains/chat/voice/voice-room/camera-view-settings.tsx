/**
 * Camera mode's view options: the corner button, and the compact panel it
 * opens.
 *
 * Two rows, and neither changes what the camera does. This is where the
 * frame-gate readout is switched on and off, over the viewfinder its numbers
 * describe; the kept-frame thumbnail is a voice preference of its own. Hiding
 * either one hides a drawing, and Live goes on sampling, sending and recording
 * every kept frame in the transcript.
 *
 * Anchored on every form factor, a touch phone included. The room is itself a
 * bottom sheet portaled into `#viewport-overlays`, and while the camera is
 * flush `useInertBehindSheet` marks that host's other children `inert`, so a
 * second sheet portaled beside the room lands inert and dead. The panel goes
 * into {@link CameraViewSettingsProps.panelHost} instead, an element the room
 * owns inside itself, which is below the level that sweep reaches and above
 * the chrome the corner button sits in.
 *
 * Over the feed the panel takes the shared over-media scrim rather than a
 * theme surface, for the reason `camera-mode-paint.ts` gives: what is behind
 * it is arbitrary video, so a token is as likely to vanish into the frame as
 * to read on it.
 *
 * A tap anywhere else closes it, through a backdrop of the panel's own rather
 * than the popover's outside-press handling. That handling waits for a
 * document-level `click`, which WebKit never synthesizes for a tap on a
 * noninteractive target, and the target here is a bare viewfinder. The
 * backdrop carries its own `onClick`, which is what `docs/CAPACITOR.md` asks
 * of any overlay that has to answer a tap, and what the design library's own
 * sheet overlay does. Closing on the click rather than the press is also what
 * keeps a dismissing tap from reaching the shutter underneath it.
 */

import { useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
 * The copy goes through the design library's own label and helper slots, so
 * the switch is named by the first and described by the second, and the line
 * saying Live keeps sending is read out with the switch that would hide its
 * signal rather than sitting unattached beside it.
 *
 * Each string carries its own color in a span inside those slots. The slots
 * paint in theme tokens, which is right over a surface the app painted and
 * wrong over an arbitrary camera frame; the inner span is what the text
 * actually takes. The row is reversed so the copy leads and the switch closes
 * it, matching the panel's reading order rather than the slots' default.
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
    <Toggle
      checked={checked}
      onChange={onChange}
      className="w-full flex-row-reverse justify-between"
      label={<span className="text-white">{title}</span>}
      helperText={<span className="text-white/65">{description}</span>}
    />
  );
}

export interface CameraViewSettingsProps {
  /**
   * Where the panel renders. The room owns it, so the panel clears the corner
   * cluster's own stacking context: portaled into that cluster it would sit at
   * the chrome's tier and the control row painted over it. Null until the room
   * has committed the element, which no press can beat.
   */
  panelHost: HTMLElement | null;
}

export function CameraViewSettings({ panelHost }: CameraViewSettingsProps) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const hudAvailable = useCameraGateHudAvailable();
  const hudEnabled = useCameraGateDebugStore.use.hudEnabled();
  const setHudEnabled = useCameraGateDebugStore.use.setHudEnabled();
  const showKeptFrame = useVoicePrefsStore.use.showKeptFrame();
  const setShowKeptFrame = useVoicePrefsStore.use.setShowKeptFrame();

  return (
    <PortalContainerProvider container={panelHost}>
      {open && panelHost
        ? createPortal(
            <div
              aria-hidden
              data-testid="camera-view-settings-backdrop"
              className="fixed inset-0"
              onClick={() => setOpen(false)}
            />,
            panelHost,
          )
        : null}
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
          // Radix presents this as a dialog, and an unnamed one is announced
          // as nothing. The heading it already carries is the name.
          aria-labelledby={titleId}
          style={cameraModeStyle()}
          className={cn(
            "flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-lg p-3 shadow-lg",
            CAMERA_MEDIA_GLASS_CLASS,
          )}
        >
          <p
            id={titleId}
            className="text-label-small-default uppercase tracking-wide text-white/60"
          >
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
  );
}
