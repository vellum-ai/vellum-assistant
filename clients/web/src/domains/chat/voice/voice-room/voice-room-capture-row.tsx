/**
 * What the camera has sent, in one row at the floor's left edge: the receipts
 * for the photos the user took, and beside them the newest frame Live shared on
 * its own.
 *
 * A photo in the strip is a receipt for something the user did. A photo taken
 * on a call goes somewhere the user cannot see, since the viewfinder does not
 * change, the assistant may say nothing for seconds, and the transcript is
 * behind the room; without the strip the press is indistinguishable from a dead
 * button, which is what sends people pressing it again. The kept frame is the
 * opposite, a frame nobody asked for, so it has to be visible at the moment it
 * goes rather than only afterwards. They wear the same shape so the two read as
 * one row, and the kept one wears the capture accent so they are not read as
 * the same thing.
 *
 * `aria-hidden` throughout. Every photo and every keep lands in the transcript
 * as its own message, which is the accessible record and the place a user
 * deletes one from, and the room's live region announces failures in words.
 *
 * Left-aligned so it never sits under the shutter, and its own left offset
 * rides the safe area the way every other edge-anchored piece of the camera's
 * chrome does: in landscape on a notched phone a flat gap puts the first
 * thumbnail under the sensor housing.
 *
 * At its widest the row is four 44px tiles and the 8px between them, so 200px
 * of content behind a 24px offset. That fits the narrowest phone the app runs
 * on with room to spare, which is why it neither caps nor scrolls: a strip that
 * cannot overflow needs no overflow behavior, and the cap that guarantees it
 * lives where the photos are kept ({@link VoiceRoomCamera}).
 */

import { X } from "lucide-react";

import { cn } from "@vellumai/design-library";

import { cameraModeStyle } from "./camera-mode-paint";
import type { VoiceRoomPhoto } from "./use-voice-room-camera";
import type { VoiceRoomSightFrame } from "./use-voice-room-sight";
import { SAFE_AREA_LEFT } from "./voice-room-layout";

/** The design's offset from the room's edge, floored by the safe area. */
const CAPTURE_ROW_LEFT = `max(1.5rem, ${SAFE_AREA_LEFT})`;

export interface VoiceRoomCaptureRowProps {
  /** The recent photos, oldest first. Capped by the camera hook at three. */
  readonly photos: readonly VoiceRoomPhoto[];
  /**
   * The newest view Live shared, or null. Null while Live is off, and while
   * the camera's view options have the thumbnail stood down.
   */
  readonly keptFrame: VoiceRoomSightFrame | null;
}

export function VoiceRoomCaptureRow({
  photos,
  keptFrame,
}: VoiceRoomCaptureRowProps) {
  if (photos.length === 0 && !keptFrame) {
    return null;
  }
  return (
    <div
      data-testid="voice-room-capture-row"
      className="flex items-center gap-2 self-start"
      style={{ paddingLeft: CAPTURE_ROW_LEFT }}
    >
      {photos.length > 0 ? (
        <ul
          aria-hidden
          data-testid="voice-room-photo-strip"
          className="flex items-center gap-2"
        >
          {photos.map((photo) => (
            <li key={photo.id} className="relative">
              <img
                src={photo.previewUrl}
                alt=""
                data-testid="voice-room-photo"
                data-status={photo.status}
                className={cn(
                  "size-11 rounded-lg border object-cover transition",
                  "border-[var(--room-border)]",
                  photo.status === "sending" && "opacity-50",
                  photo.status === "failed" && "opacity-40 grayscale",
                )}
              />
              {photo.status === "failed" ? (
                <span className="absolute inset-0 flex items-center justify-center">
                  <X className="size-5 text-red-300" strokeWidth={3} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {/* Keyed on the id, which replays the ring on every keep. */}
      {keptFrame ? (
        <img
          key={keptFrame.attachmentId}
          src={keptFrame.previewUrl}
          alt=""
          aria-hidden
          data-testid="voice-room-sight-frame"
          style={cameraModeStyle()}
          className="sight-frame-kept size-11 rounded-lg object-cover ring-2 ring-[var(--camera-accent)]"
        />
      ) : null}
    </div>
  );
}
