/**
 * The full-screen viewfinder behind `deeplink.openCamera`: a camera that opens
 * because a widget asked for it, with a shutter that turns the frame into an
 * attachment.
 *
 * ## Why not a hidden `<input type="file" capture="environment">`
 *
 * Because nothing here is a tap. iOS WKWebView presents a file input's picker
 * only for a click carrying transient DOM user activation, and this surface is
 * opened by a URL drained from Capacitor's `appUrlOpen` bridge, which
 * establishes none: a widget button was pressed on the Home Screen, outside the
 * web view entirely. A `.click()` from the effect that drains it is therefore
 * consumed in silence and no camera ever appears, on exactly the platform the
 * command exists for. The bridge has no such requirement, so the camera is
 * opened through it instead and the input is gone from this path.
 *
 * ## What actually opens
 *
 * {@link useVoiceCamera}, the same acquisition the voice room runs on: the
 * native Capacitor preview where the shell registers that plugin, and a
 * `getUserMedia` `<video>` everywhere else, which is what keeps a freshly
 * deployed bundle working inside an older installed shell. The native preview
 * is a layer *behind* the web view, so this box paints nothing while it is up.
 *
 * Portalled to `document.body` for two reasons, both about where it is mounted
 * from: the composer sits under transformed ancestors, which would make a
 * `fixed` box position against one of them instead of the viewport, and
 * `index.css` hides the whole of `#root` while the native preview is live, so a
 * surface rendered inside it would vanish with everything else.
 *
 * Unmounting is what releases the camera: `useVoiceCamera` stops the capture on
 * teardown, so every way out of here (the shutter, the close control, Escape, a
 * failure, the composer going away) turns the hardware off without anything
 * having to remember to.
 */

import { toast } from "@vellumai/design-library";
import { SwitchCamera, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useVoiceCamera } from "@/domains/chat/voice/voice-room/voice-camera";
import { VoiceRoomControl } from "@/domains/chat/voice/voice-room/voice-room-control";
import {
  SAFE_AREA_BOTTOM,
  SAFE_AREA_TOP,
} from "@/domains/chat/voice/voice-room/voice-room-layout";
import { useTranslation } from "@/i18n";
import { cn } from "@/utils/misc";

interface CameraCaptureOverlayProps {
  /**
   * Receives the photo, in the shape the composer's own drop and picker paths
   * hand it over in, so it picks up the same vision gate, auto-resize and HEIC
   * conversion they do.
   */
  onCapture: (files: File[]) => void;
  /** Take the surface down. Unmounting is what releases the camera. */
  onClose: () => void;
}

export function CameraCaptureOverlay({
  onCapture,
  onClose,
}: CameraCaptureOverlayProps) {
  const { t } = useTranslation("chat");
  const videoRef = useRef<HTMLVideoElement>(null);
  const { captureFrame, error, flipCamera, native, open, openCamera } =
    useVoiceCamera(videoRef);
  const [capturing, setCapturing] = useState(false);

  // Once per mount, guarded rather than run off `openCamera`'s identity: that
  // callback is reminted whenever the camera flips, and reopening the camera
  // from underneath a flip is how a viewfinder ends up pointing back the way
  // the user just turned it away from.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) {
      return;
    }
    openedRef.current = true;
    void openCamera();
  }, [openCamera]);

  // Closed before the toast, so the message is not raised behind a native
  // preview that has already covered the app.
  useEffect(() => {
    if (error === null) {
      return;
    }
    onClose();
    toast.error(t("cameraDeepLink.openFailed"));
  }, [error, onClose, t]);

  const takePhoto = useCallback(async () => {
    setCapturing(true);
    const file = await captureFrame();
    if (!file) {
      onClose();
      toast.error(t("cameraDeepLink.captureFailed"));
      return;
    }
    onCapture([file]);
    onClose();
  }, [captureFrame, onCapture, onClose, t]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("cameraDeepLink.title")}
      data-testid="camera-deep-link-surface"
      className={cn(
        "fixed inset-0 z-50",
        // The native preview sits behind the web view, so a background here
        // would paint straight over it. The fallback's `<video>` is in this box
        // and wants the black behind it while the first frame decodes.
        native ? "bg-transparent" : "bg-black",
      )}
    >
      {native ? null : (
        <video
          ref={videoRef}
          aria-hidden
          autoPlay
          muted
          playsInline
          className="absolute inset-0 size-full object-cover"
        />
      )}

      <div
        className="absolute left-4 z-10"
        style={{ top: `calc(1rem + ${SAFE_AREA_TOP})` }}
      >
        <VoiceRoomControl
          label={t("cameraDeepLink.close")}
          onClick={onClose}
          overMedia
          data-testid="camera-deep-link-close"
        >
          <X className="size-5" />
        </VoiceRoomControl>
      </div>

      <div
        className="absolute inset-x-0 z-10 flex items-center justify-center"
        style={{ bottom: `calc(2rem + ${SAFE_AREA_BOTTOM})` }}
      >
        <button
          type="button"
          onClick={() => void takePhoto()}
          disabled={!open || capturing}
          aria-label={t("cameraDeepLink.shutter")}
          data-testid="camera-deep-link-shutter"
          className={cn(
            "flex size-16 items-center justify-center rounded-full border-4 transition",
            // Video is the only thing this is ever seen against, and the frame
            // can be any brightness, so the white ring sits on a dark fill and
            // a dark outer hairline: one edge or the other separates it at
            // both extremes. Matches the voice room's shutter for the same
            // reason.
            "border-white bg-black/30 shadow-[0_0_0_1.5px_rgba(0,0,0,0.4)]",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
            capturing || !open ? "opacity-60" : "hover:bg-black/45",
          )}
        >
          <span
            className={cn(
              "rounded-full bg-white transition-all",
              capturing ? "size-6" : "size-11",
            )}
          />
        </button>

        <div className="absolute right-8">
          <VoiceRoomControl
            label={t("cameraDeepLink.flip")}
            onClick={() => void flipCamera()}
            overMedia
            data-testid="camera-deep-link-flip"
          >
            <SwitchCamera className="size-5" />
          </VoiceRoomControl>
        </div>
      </div>
    </div>,
    document.body,
  );
}
