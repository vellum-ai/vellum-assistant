/**
 * The readout on a viewport with no room for the card: a slim strip in the
 * mount's own slot, and the whole readout in a sheet at the floor once the
 * strip is tapped.
 *
 * The card is 288px wide and taller than a phone can spare over a viewfinder,
 * and a viewfinder covered by its own instrument is not a viewfinder. So the
 * standing form is one glass row carrying the verdict and the three meters at
 * glyph size, which answers the only question a live readout is watched for
 * (is this frame being kept, and by how far), and everything with a number or a
 * control on it waits behind a tap.
 *
 * ## Where the strip sits
 *
 * The mount hands down the card's slot, which is 2.75rem below the room's
 * chrome band: clear of the status pill, and 0.5rem inside the bottom of the
 * 3.25rem corner controls. A card is narrow enough for that overlap to be a
 * band it never reaches across, and a strip is not, so the strip takes another
 * 1.5rem of the offset and starts a clear 1rem under the controls. Margin
 * rather than a second `top`, so the mount stays the one thing saying where the
 * readout begins.
 *
 * ## Why the sheet is not a `BottomSheet`
 *
 * The room is itself a bottom sheet portaled into `#viewport-overlays`, and
 * while the camera is flush `useInertBehindSheet` marks that host's other
 * children `inert`, so a second sheet portaled beside the room lands inert and
 * dead. This one is not portaled at all: the mount is already a direct child of
 * the room's own box, so a `z-30` sibling clears every layer the room draws
 * (chrome and control rows at `z-10`, the connect card at `z-20`) without
 * leaving the subtree that the inert sweep spares and the native camera shells
 * keep visible in front of their preview.
 *
 * ## Dismissal
 *
 * A tap on the backdrop, through an `onClick` the backdrop carries itself:
 * `docs/CAPACITOR.md` records that WebKit synthesizes no `click` for a tap on a
 * noninteractive target, so a document-level listener would never hear the tap,
 * and closing on the click rather than the press keeps a dismissing tap off the
 * shutter underneath. The visible affordance is a grabber-shaped button, and it
 * dismisses on tap rather than on a drag: the room's own chrome answers a
 * downward drag by minimizing the whole call, so a sheet that read drags here
 * would be competing with that for the same gesture.
 *
 * ## Why the sheet keeps the presses that land on it
 *
 * That same room drag is what a swipe down this sheet would be competing with.
 * The readout is taller than the sheet's height cap, so the lower sliders are
 * reachable only by scrolling, and the room answers a downward drag anywhere
 * inside it by minimizing the whole call.
 *
 * The room's drag is started from a React `onPointerDown` on the room's own
 * element rather than from Motion's built-in listener, which is what makes this
 * expressible at all: see `voice-room.tsx` for why a native listener there
 * cannot be declined from in here. Inside React's propagation the tree order is
 * the useful one, so the sheet keeps its own presses with a plain
 * `stopPropagation()` in its own `onPointerDown`, which runs before the room's
 * and leaves every handler under it, Radix's sliders included, untouched.
 *
 * Stopping propagation is not `preventDefault`: `docs/CAPACITOR.md` bans the
 * latter on `pointerdown` because WebKit drops the rest of the sequence with
 * it, and the tap that follows this press still lands, which is what the
 * grabber's dismissal and every switch inside the readout ride.
 *
 * The whole sheet rather than an inner scroll region: a press that lands on
 * this surface is aimed at this surface. The backdrop keeps its presses too,
 * for the same reason read the other way: it exists to be tapped through, and a
 * press aimed at dismissing a panel must not turn into a pull on the call
 * behind it. Between them they cover the room while the sheet is open, which
 * they already did for the eye; a sheet that is closed attaches nothing and
 * leaves the room dragged from everywhere, the strip included.
 *
 * The drag has a second half that is the browser's rather than Motion's: the
 * room carries `touch-action: pan-x` for as long as it is draggable, which is
 * how it stops the browser panning under the gesture it owns. The sheet asks
 * for the vertical pan back on its own box, the way every other scrolling panel
 * over a claimed gesture in this app does.
 */

import { useState, type CSSProperties, type PointerEvent } from "react";
import { cn } from "@vellumai/design-library";

import { CAMERA_MEDIA_GLASS_CLASS } from "@/domains/chat/voice/voice-room/camera-mode-paint";
import { SAFE_AREA_BOTTOM } from "@/domains/chat/voice/voice-room/voice-room-layout";
import { useTranslation } from "@/i18n";
import { useCameraGateDebugStore } from "@/stores/camera-gate-debug-store";

import {
  FrameGateHudBody,
  MiniMeter,
  frameGateMeters,
  type FrameGateHudViewProps,
} from "./frame-gate-hud-parts";

export interface FrameGateHudCompactProps extends FrameGateHudViewProps {
  /** Positioning for the mount, which owns where the strip sits. */
  className?: string;
  /** Positioning that has to be computed, such as a safe-area inset. */
  style?: CSSProperties;
}

export function FrameGateHudCompact({
  snapshot,
  surface,
  latest,
  className,
  style,
}: FrameGateHudCompactProps) {
  const { t } = useTranslation("chat");
  const overrides = useCameraGateDebugStore.use.overrides();
  const [expanded, setExpanded] = useState(false);
  const collapseLabel = t("frameGateHud.collapse");

  const keepPress = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  return (
    <>
      <button
        type="button"
        data-slot="frame-gate-hud"
        data-testid="frame-gate-hud-strip"
        aria-expanded={expanded}
        aria-label={expanded ? collapseLabel : t("frameGateHud.expand")}
        onClick={() => setExpanded((open) => !open)}
        className={cn(
          "flex items-center gap-2 rounded-full py-1.5 pl-2.5 pr-3 shadow-lg",
          "text-[10px] font-semibold uppercase tracking-wide",
          // Clears the corner controls the mount's own offset stops short of.
          "mt-6",
          CAMERA_MEDIA_GLASS_CLASS,
          className,
        )}
        style={style}
      >
        <span>
          {latest.keep ? t("frameGateHud.keep") : t("frameGateHud.skip")}
        </span>
        {frameGateMeters(latest, overrides).map((meter) => (
          <MiniMeter key={meter.key} meter={meter} />
        ))}
      </button>

      {expanded ? (
        <>
          {/* Covers the room rather than the sheet, so a press inside the
              sheet stays the sheet's. */}
          <div
            aria-hidden
            data-testid="frame-gate-hud-backdrop"
            className="absolute inset-0 z-30"
            onPointerDown={keepPress}
            onClick={() => setExpanded(false)}
          />
          <div
            data-slot="frame-gate-hud"
            data-testid="frame-gate-hud-sheet"
            onPointerDown={keepPress}
            className={cn(
              "absolute inset-x-0 bottom-0 z-30 max-h-[70%] overflow-y-auto overscroll-contain",
              "flex flex-col gap-3 rounded-t-xl px-3 pt-2 text-[11px] leading-tight shadow-lg",
              CAMERA_MEDIA_GLASS_CLASS,
            )}
            style={{
              paddingBottom: `calc(0.75rem + ${SAFE_AREA_BOTTOM})`,
              touchAction: "pan-y",
            }}
          >
            {/* The bar a sheet is closed by everywhere else, at a size a thumb
                can find. The bar itself is 4px; the button around it is the
                target. */}
            <button
              type="button"
              data-testid="frame-gate-hud-collapse"
              aria-label={collapseLabel}
              onClick={() => setExpanded(false)}
              className="mx-auto flex h-6 w-16 shrink-0 items-center justify-center"
            >
              <span aria-hidden className="h-1 w-9 rounded-full bg-white/50" />
            </button>
            <FrameGateHudBody
              snapshot={snapshot}
              surface={surface}
              latest={latest}
            />
          </div>
        </>
      ) : null}
    </>
  );
}
