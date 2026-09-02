/**
 * Tests for `VoiceRoomCaptureRow`, the receipts and the kept frame on the
 * camera's floor.
 *
 * Load-bearing contracts: that an empty floor draws no row at all, so the
 * column above the shutter does not carry an empty band, and that the strip and
 * the kept frame share one row.
 *
 * The row's offset and its width are not checkable here. happy-dom lays nothing
 * out, and it drops the `max()` the offset is written as rather than storing
 * it, so both the padding and the geometry are answered in a browser against
 * `camera-mode-screen.stories.tsx`, story "NarrowPhoneCaptureRow".
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import { VoiceRoomCaptureRow } from "@/domains/chat/voice/voice-room/voice-room-capture-row";
import type { VoiceRoomPhoto } from "@/domains/chat/voice/voice-room/use-voice-room-camera";

afterEach(() => {
  cleanup();
});

const PHOTOS: readonly VoiceRoomPhoto[] = [
  { id: 1, previewUrl: "blob:one", status: "sent" },
  { id: 2, previewUrl: "blob:two", status: "sending" },
  { id: 3, previewUrl: "blob:three", status: "failed" },
];

const KEPT = { attachmentId: "att-1", previewUrl: "blob:kept" };

describe("VoiceRoomCaptureRow", () => {
  test("draws nothing with no photos and no kept frame", () => {
    render(<VoiceRoomCaptureRow photos={[]} keptFrame={null} />);

    expect(screen.queryByTestId("voice-room-capture-row")).toBeNull();
  });

  test("draws the strip and the kept frame in one row", () => {
    render(<VoiceRoomCaptureRow photos={PHOTOS} keptFrame={KEPT} />);

    const row = screen.getByTestId("voice-room-capture-row");
    expect(screen.getAllByTestId("voice-room-photo")).toHaveLength(3);
    expect(row.contains(screen.getByTestId("voice-room-photo-strip"))).toBe(
      true,
    );
    expect(row.contains(screen.getByTestId("voice-room-sight-frame"))).toBe(
      true,
    );
  });

  test("draws the row for a kept frame with no photos behind it", () => {
    render(<VoiceRoomCaptureRow photos={[]} keptFrame={KEPT} />);

    expect(screen.getByTestId("voice-room-capture-row")).not.toBeNull();
    expect(screen.queryByTestId("voice-room-photo-strip")).toBeNull();
  });
});
