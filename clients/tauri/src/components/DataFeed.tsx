import type { JSX } from "react";
import { useEffect, useRef } from "react";

import { formatTimestamp } from "../lib/format.js";

export type FeedTone = "accent" | "ok" | "warn" | "danger" | "violet";

export interface FeedEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly tag: string;
  readonly text: string;
  readonly tone?: FeedTone;
}

interface DataFeedProps {
  readonly entries: readonly FeedEntry[];
}

/**
 * Cinematic, log-style scrolling feed that replaces the conversational
 * transcript. Renders behind-the-scenes activity (perception, voice
 * lifecycle, host actions, gateway events) in a CRT-terminal aesthetic.
 *
 * The feed is intentionally not a chat surface — operator/assistant
 * speech is surfaced via the floating subtitle overlay in `App.tsx`.
 */
export function DataFeed(props: DataFeedProps): JSX.Element {
  const { entries } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="data-feed flex h-full min-h-[120px] items-center justify-center px-6 text-center">
        <div>
          <p className="font-display text-[10px] tracking-[0.42em] text-hud-accent">
            telemetry idle
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.28em] text-hud-mute">
            awaiting first signal · stream warming up
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="data-feed h-full overflow-y-auto py-2"
      role="log"
      aria-live="polite"
    >
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={`data-feed-row tone-${entry.tone ?? "accent"}`}
        >
          <span className="feed-time">{formatTimestamp(entry.timestamp)}</span>
          <span className="feed-tag">{entry.tag}</span>
          <span className="feed-body truncate">{entry.text}</span>
        </div>
      ))}
    </div>
  );
}
