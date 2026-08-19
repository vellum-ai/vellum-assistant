import { useCallback, useEffect, useState } from "react";

import {
  getHotkeys,
  onHotkeysChange,
  setHotkey,
  type ResolvedHotkey,
} from "@/runtime/hotkeys";

import {
  eventToAccelerator,
  findConflict,
} from "@/domains/settings/keyboard-shortcuts/electron-accelerator";

/**
 * Rebinding a command: the catalog, which command is currently recording, and
 * the write paths that change a binding.
 *
 * Extracted from the Keyboard Shortcuts settings so a single shortcut can be
 * rebound from wherever it belongs, rather than only from the page that lists
 * them all. Settings, Voice rebinds Talk from its own card for that reason: a
 * user reading about the voice shortcut is exactly the user who wants to
 * change it, and sending them to another screen to do it is the kind of trip
 * people abandon.
 *
 * **Conflicts are checked against the whole catalog, not the caller's slice.**
 * A binding taken by a command this surface never shows still collides, so
 * `catalog` always holds every entry, including the reserved ones that render
 * no row and exist only to be collided with.
 */
export interface HotkeyRecorder {
  /** Every command, rebindable or reserved. */
  catalog: ResolvedHotkey[];
  /** The command currently listening for a keypress, if any. */
  recordingKey: string | null;
  /** The command a rejected write collided with, and which command it was. */
  conflict: { key: string; label: string } | null;
  startRecording: (key: string) => void;
  stopRecording: () => void;
  /** Revert to the compiled default. */
  resetHotkey: (key: string) => void;
  /** Unbind entirely. */
  removeHotkey: (key: string) => void;
}

export function useHotkeyRecorder(options?: {
  /**
   * Called after a recorded chord is written. Lets a caller settle anything
   * the binding is exclusive with, which the recorder itself cannot know
   * about (Settings, Voice clears Fn here).
   */
  onBound?: (key: string) => void;
}): HotkeyRecorder {
  const onBound = options?.onBound;
  const [catalog, setCatalog] = useState<ResolvedHotkey[]>([]);
  const [recordingKey, setRecordingKey] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    key: string;
    label: string;
  } | null>(null);

  const refresh = useCallback(() => {
    void getHotkeys().then(setCatalog);
  }, []);

  useEffect(() => {
    refresh();
    return onHotkeysChange(setCatalog);
  }, [refresh]);

  const stopRecording = useCallback(() => {
    setRecordingKey(null);
    setConflict(null);
  }, []);

  useEffect(() => {
    if (recordingKey === null) {
      return;
    }

    const handleKeydown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === "Escape") {
        stopRecording();
        return;
      }

      const accelerator = eventToAccelerator(event);
      if (accelerator === null) {
        return;
      }

      const clash = findConflict(catalog, recordingKey, accelerator);
      if (clash !== null) {
        setConflict({ key: recordingKey, label: clash.label });
        return;
      }

      // Only after the write lands. A newer renderer against an older host
      // whose catalog predates this command is rejected by main, and settling
      // an exclusive binding on a write that failed would clear the one that
      // still works while saving nothing in its place.
      void setHotkey(recordingKey, accelerator)
        .then(() => {
          onBound?.(recordingKey);
          refresh();
        })
        .catch(() => {
          // The binding is unchanged, so re-read rather than assume: the row
          // must show what the host actually holds.
          refresh();
        });
      stopRecording();
    };

    window.addEventListener("keydown", handleKeydown, true);
    return () => window.removeEventListener("keydown", handleKeydown, true);
  }, [recordingKey, catalog, onBound, refresh, stopRecording]);

  const startRecording = useCallback((key: string) => {
    setConflict(null);
    setRecordingKey(key);
  }, []);

  const resetHotkey = useCallback(
    (key: string) => {
      // Reverting to the compiled default is still a write, so it must clear the
      // same conflict bar as recording: a default freed by rebinding this
      // command may have since been claimed by another, and writing `null`
      // blindly would resurrect that accelerator and shadow the other binding.
      const fallback =
        catalog.find((entry) => entry.key === key)?.defaultAccelerator ?? "";
      const clash = findConflict(catalog, key, fallback);
      if (clash !== null) {
        setRecordingKey(null);
        setConflict({ key, label: clash.label });
        return;
      }
      stopRecording();
      void setHotkey(key, null).then(refresh);
    },
    [catalog, refresh, stopRecording],
  );

  const removeHotkey = useCallback(
    (key: string) => {
      stopRecording();
      void setHotkey(key, "").then(refresh);
    },
    [refresh, stopRecording],
  );

  return {
    catalog,
    recordingKey,
    conflict,
    startRecording,
    stopRecording,
    resetHotkey,
    removeHotkey,
  };
}
