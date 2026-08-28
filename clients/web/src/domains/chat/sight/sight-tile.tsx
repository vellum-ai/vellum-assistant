/**
 * The floating viewfinder the Eyes toggle raises: a small live preview parked
 * in the chat's bottom-right corner with one control on it, close.
 *
 * It is also what makes the camera useful. The frame sampler needs an element
 * with decoded frames in it, so the tile hands its `<video>` to the store the
 * moment playback starts and takes it back on unmount; nothing is sampled while
 * no tile is up.
 */

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button, cn } from "@vellumai/design-library";

import {
  useSightStore,
  type SightError,
} from "@/domains/chat/sight/sight-store";
import { CAMERA_MEDIA_GLASS_CLASS } from "@/domains/chat/voice/voice-room/camera-mode-paint";
import { useTranslation } from "@/i18n";

/** Viewfinder width. Large enough to aim with, small enough to ignore. */
const TILE_WIDTH_CLASS = "w-60";

/**
 * What the tile says when there is no picture. Three sentences rather than one
 * with a branch: the two a user can act on say what to do, and the rest share
 * the honest "there isn't one" ending.
 */
function errorMessageKey(error: SightError | null) {
  if (error === "permission-denied") {
    return "sightTile.permissionDenied" as const;
  }
  if (error === "interrupted") {
    return "sightTile.interrupted" as const;
  }
  return "sightTile.unavailable" as const;
}

export function SightTile() {
  const { t } = useTranslation("chat");
  const status = useSightStore.use.status();
  const stream = useSightStore.use.stream();
  const error = useSightStore.use.error();
  const stop = useSightStore.use.stop();
  const attachPreviewVideo = useSightStore.use.attachPreviewVideo();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  // A tile that leaves the tree gives the camera back with it. This is the
  // capture's only on-screen control, so a surface that goes away with the
  // hardware still running (a window crossing the mobile breakpoint, a route
  // out of the chat layout) strands a lit camera behind no viewfinder and no
  // close button. The voice room releases its own capture on the same event
  // and for the same reason.
  //
  // The status check keeps a teardown with nothing to release genuinely inert.
  // `stop` bumps the store's acquire epoch, which is how it cancels a request
  // still in flight, so an unconditional call would make every teardown a
  // cancellation signal, including the cleanup StrictMode runs between its two
  // mount passes. Turning the camera off does not unmount this component (it
  // renders null and stays), so the toggle's own path never reaches here.
  //
  // Read through `getState` rather than the render-time actions: a cleanup runs
  // outside the render cycle, and the status it acts on has to be the one
  // standing at teardown.
  useEffect(() => {
    return () => {
      const sight = useSightStore.getState();
      sight.attachPreviewVideo(null);
      if (sight.status !== "off") {
        sight.stop();
      }
    };
  }, []);

  if (status === "off") {
    return null;
  }

  const failed = status === "error";

  return (
    <div
      data-slot="sight-tile"
      className={cn(
        "fixed bottom-28 right-8 z-30 overflow-hidden rounded-lg",
        "border border-[var(--border-element)] bg-[var(--surface-lift)] shadow-lg",
        TILE_WIDTH_CLASS,
      )}
    >
      {failed ? (
        <p className="px-3 py-4 text-sm text-[var(--content-secondary)]">
          {t(errorMessageKey(error))}
        </p>
      ) : (
        // `starting` renders the same element with nothing in it yet, so the
        // first decoded frame lands in a box that is already on screen.
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          onPlaying={() => attachPreviewVideo(videoRef.current)}
          className="block aspect-[4/3] w-full bg-[var(--surface-sunken)] object-cover"
        />
      )}
      <Button
        variant="ghost"
        iconOnly={<X />}
        expandOnMobile={false}
        onClick={stop}
        aria-label={t("sightTile.close")}
        title={t("sightTile.close")}
        className={cn(
          "absolute right-1 top-1 rounded-full",
          // Over live video no theme token is reliably legible, so the control
          // takes the app's shared over-media scrim instead.
          failed
            ? "[--vbtn-fg:var(--content-tertiary)]"
            : cn(CAMERA_MEDIA_GLASS_CLASS, "[--vbtn-fg:var(--aux-white)]"),
        )}
      />
    </div>
  );
}
