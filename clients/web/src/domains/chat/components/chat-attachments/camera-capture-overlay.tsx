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
 *
 * What teardown does not release is a frame already being encoded, so leaving
 * is recorded on a ref that the shutter rechecks on the far side of its await.
 * A frame that lands after the user is gone is dropped rather than attached,
 * and a frame that failed by then is a close the user asked for rather than an
 * error worth a toast.
 *
 * ## Modality
 *
 * `@radix-ui/react-dialog`, the primitive the design library's `Modal` is built
 * on, taken one layer down rather than through `Modal` itself: `Modal` paints a
 * scrim and a centered card, and both are wrong here, since the native preview
 * is behind the web view and anything painted over it hides the camera. What
 * the primitive is here for is the modality `role="dialog"` only claims: focus
 * moves in on mount and cycles inside, the rest of the app leaves the
 * accessibility tree and stops taking pointer events, and focus returns to
 * whatever held it when the surface goes away. That matters most on the
 * `getUserMedia` path, where `#root` stays visible behind a full-screen
 * viewfinder and would otherwise still be reachable by keyboard and VoiceOver.
 *
 * Escape belongs to the dialog layer for the same reason, so whatever is
 * stacked highest owns the key.
 */

import * as Dialog from "@radix-ui/react-dialog";
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
  const surfaceRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { captureFrame, error, flipCamera, native, open, openCamera } =
    useVoiceCamera(videoRef);
  const [capturing, setCapturing] = useState(false);

  // Read while rendering, which is the last moment it is still true: the focus
  // scope moves focus into the dialog in its own mount effect, and effects here
  // run after that one.
  const [focusOnClose] = useState<HTMLElement | null>(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  // Read through a ref rather than depended on: `openCamera` is reminted
  // whenever the camera flips, and reopening the camera from underneath a flip
  // is how a viewfinder ends up pointing back the way the user just turned it
  // away from.
  const openCameraRef = useRef(openCamera);
  useEffect(() => {
    openCameraRef.current = openCamera;
  }, [openCamera]);

  // Once per mount, and that includes the second half of StrictMode's
  // simulated remount. The cleanup between the two passes releases the camera
  // (`useVoiceCamera` stops the capture in its own teardown) and cancels the
  // acquisition still in flight, so a latch that only ever opened once leaves
  // a development build looking at a dead viewfinder with the shutter disabled
  // behind it.
  useEffect(() => {
    void openCameraRef.current();
  }, []);

  // Every exit routes through here, so anything still in flight has one flag to
  // read. Set before the parent is told, since `onClose` only asks it to
  // unmount and a frame can resolve in between.
  const closedRef = useRef(false);
  const close = useCallback(() => {
    closedRef.current = true;
    onClose();
  }, [onClose]);

  // The composer can also take this surface down without going through
  // `close`. Cleared on the way in as well as set on the way out: refs survive
  // StrictMode's simulated unmount, so a flag left standing from it would bail
  // the shutter out for the whole life of the surface.
  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
    };
  }, []);

  // Closed before the toast, so the message is not raised behind a native
  // preview that has already covered the app.
  useEffect(() => {
    if (error === null) {
      return;
    }
    close();
    toast.error(t("cameraDeepLink.openFailed"));
  }, [close, error, t]);

  // Read in the same tick the shutter fires in, unlike `capturing`, which only
  // disables the button on the render after it.
  const capturingRef = useRef(false);
  const takePhoto = useCallback(async () => {
    if (capturingRef.current || closedRef.current) {
      return;
    }
    capturingRef.current = true;
    setCapturing(true);

    const file = await captureFrame();
    capturingRef.current = false;

    // The user left while the frame was encoding: no attachment from a surface
    // they dismissed, and no failure toast for a close they meant.
    if (closedRef.current) {
      setCapturing(false);
      return;
    }

    if (!file) {
      setCapturing(false);
      close();
      toast.error(t("cameraDeepLink.captureFailed"));
      return;
    }
    onCapture([file]);
    close();
  }, [captureFrame, close, onCapture, t]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        close();
      }
    },
    [close],
  );

  return createPortal(
    <Dialog.Root open onOpenChange={handleOpenChange}>
      <Dialog.Content
        ref={surfaceRef}
        // No description to point at, and the primitive otherwise leaves the
        // attribute aimed at an id nothing carries.
        aria-describedby={undefined}
        data-testid="camera-deep-link-surface"
        // The box itself takes focus, rather than the first control in it. Both
        // of those are icon buttons carrying a tooltip, and a tooltip opens on
        // focus and is a dismissable layer of its own, so autofocusing one
        // floats a label over the viewfinder the moment the camera appears and
        // hands it the first Escape. Landing on the dialog announces its title,
        // leaves Escape with this surface, and puts Tab one press from the
        // close control.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          surfaceRef.current?.focus();
        }}
        // The dialog has no trigger to hand focus back to, which is what the
        // primitive's default reaches for, so the element that had focus when
        // the camera opened is restored here instead. Skipped once it is gone,
        // since the composer can unmount underneath the surface.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (focusOnClose?.isConnected) {
            focusOnClose.focus();
          }
        }}
        className={cn(
          "fixed inset-0 z-50 focus:outline-none",
          // The native preview sits behind the web view, so a background here
          // would paint straight over it. The fallback's `<video>` is in this
          // box and wants the black behind it while the first frame decodes.
          native ? "bg-transparent" : "bg-black",
        )}
      >
        <Dialog.Title className="sr-only">
          {t("cameraDeepLink.title")}
        </Dialog.Title>

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

        {/* First tabbable control in the box, so one Tab off the dialog is the
            way out of here. */}
        <div
          className="absolute left-4 z-10"
          style={{ top: `calc(1rem + ${SAFE_AREA_TOP})` }}
        >
          <VoiceRoomControl
            label={t("cameraDeepLink.close")}
            onClick={close}
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
              // Video is the only thing this is ever seen against, and the
              // frame can be any brightness, so the white ring sits on a dark
              // fill and a dark outer hairline: one edge or the other separates
              // it at both extremes. Matches the voice room's shutter for the
              // same reason.
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
      </Dialog.Content>
    </Dialog.Root>,
    document.body,
  );
}
