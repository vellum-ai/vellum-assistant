import type { JSX } from "react";
import { useEffect, useRef } from "react";

import { formatTimestamp, shortLabel } from "../lib/format.js";
import type { TranscriptEntry } from "../types.js";

interface TranscriptPaneProps {
  readonly entries: readonly TranscriptEntry[];
}

const ROLE_LABEL: Record<TranscriptEntry["role"], string> = {
  user: "OPERATOR",
  assistant: "ELI",
  system: "SYSTEM",
};

/**
 * Rolling transcript with auto-scroll-to-bottom. Latest entry is always
 * fully visible; older entries dim out as they drift up the pane.
 */
export function TranscriptPane(props: TranscriptPaneProps): JSX.Element {
  const { entries } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-hud-mute">
          Awaiting input — say &quot;Jarvis&quot; or type a command.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="hud-transcript flex h-full flex-col gap-2 overflow-y-auto px-6 py-4"
    >
      {entries.map((entry) => (
        <TranscriptRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function TranscriptRow({
  entry,
}: {
  entry: TranscriptEntry;
}): JSX.Element {
  const isUser = entry.role === "user";
  const isSystem = entry.role === "system";
  const align = isUser ? "items-end text-right" : "items-start text-left";
  const accent = isUser
    ? "border-hud-accent/60 text-hud-accent"
    : isSystem
      ? "border-hud-warn/60 text-hud-warn"
      : "border-hud-ok/60 text-hud-ok";
  const partial = entry.state === "partial" ? "after:content-['▍']" : "";

  return (
    <div className={`flex flex-col ${align}`}>
      <div
        className={`font-display text-[9px] tracking-[0.5em] ${accent} opacity-80`}
      >
        {ROLE_LABEL[entry.role]} · {formatTimestamp(entry.timestamp)}
      </div>
      <div
        className={`mt-1 max-w-[85%] rounded-sm border-l-2 px-3 py-2 font-mono text-sm leading-snug ${accent} ${partial}`}
        style={{ backgroundColor: "rgba(7, 22, 33, 0.45)" }}
      >
        {shortLabel(entry.text, 600)}
      </div>
    </div>
  );
}
