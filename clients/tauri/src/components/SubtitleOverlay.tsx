import type { JSX } from "react";
import { useEffect, useState } from "react";

import { shortLabel } from "../lib/format.js";
import type { TranscriptEntry } from "../types.js";

interface SubtitleOverlayProps {
  readonly entries: readonly TranscriptEntry[];
}

/**
 * Floating "movie-subtitle" line above the command bar. Surfaces the
 * latest spoken exchange momentarily without exposing a persistent chat
 * transcript. Auto-dismisses 6s after the last update; streaming
 * (partial) entries reset the timer so they remain visible while text
 * is still arriving.
 *
 * This is intentionally minimal — for a full conversation history users
 * can open the assistant's main UI, the HUD focuses on ambient awareness.
 */
export function SubtitleOverlay({ entries }: SubtitleOverlayProps): JSX.Element | null {
  const last = entries
    .filter((e) => e.role !== "system" && e.text.trim().length > 0)
    .slice(-1)[0];

  const [visible, setVisible] = useState<TranscriptEntry | null>(last ?? null);

  useEffect(() => {
    if (!last) {
      setVisible(null);
      return;
    }
    setVisible(last);
    if (last.state === "partial") return;
    const id = setTimeout(() => setVisible(null), 6_000);
    return () => clearTimeout(id);
  }, [last?.id, last?.state, last?.text]);

  if (!visible) return null;

  const isUser = visible.role === "user";
  return (
    <div className={`subtitle-banner ${isUser ? "user" : ""}`}>
      <div className="font-display text-[8px] tracking-[0.42em] opacity-60">
        {isUser ? "operator" : "eli"} ·{" "}
        {visible.state === "partial" ? "live" : "rx"}
      </div>
      <div className="mt-1 leading-snug">
        {shortLabel(visible.text, 240)}
        {visible.state === "partial" ? (
          <span className="ml-1 animate-pulse">▍</span>
        ) : null}
      </div>
    </div>
  );
}
