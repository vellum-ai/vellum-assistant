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

import { useSightStore } from "@/domains/chat/sight/sight-store";
import { CAMERA_MEDIA_GLASS_CLASS } from "@/domains/chat/voice/voice-room/camera-mode-paint";
import { useTranslation } from "@/i18n";

/** Viewfinder width. Large enough to aim with, small enough to ignore. */
const TILE_WIDTH_CLASS = "w-60";

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

  // Unregistering on unmount rather than on every stream change: the store
  // drops its own registration when the camera is released, and this covers
  // the tile leaving the tree with the camera still live.
  useEffect(() => {
    return () => {
      attachPreviewVideo(null);
    };
  }, [attachPreviewVideo]);

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
          {error === "permission-denied"
            ? t("sightTile.permissionDenied")
            : t("sightTile.unavailable")}
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
