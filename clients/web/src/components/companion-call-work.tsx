import { Check, X } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

import type { VoiceActivityWork } from "@vellumai/ipc-contract";

import { useTranslation } from "@/i18n";

/**
 * The work a call is carrying, drawn on the call's bar: a count on the row
 * ({@link CompanionCallWorkSpinner} is its arc), and a press on it opens
 * {@link CompanionCallWorkShelf}, joined to the bar, listing each piece.
 */

/**
 * How many lines the shelf lists before it sums up the rest. Keeps the shelf
 * inside the canvas main reserves above the bar for a card, so opening it
 * never has to resize the window.
 */
export const CALL_WORK_SHELF_MAX_LINES = 5;

export const runningCallWork = (work: readonly VoiceActivityWork[]) =>
  work.filter((item) => item.state === "running");

export const waitingCallWork = (work: readonly VoiceActivityWork[]) =>
  work.filter((item) => item.state === "waiting");

export const callWorkAccent = (accentHex: string): CSSProperties =>
  ({ ["--companion-ring-accent" as string]: accentHex }) as CSSProperties;

/**
 * A small arc turning in the accent: the chip-sized form of the working ring.
 * Held still for work waiting on the user, which is not moving.
 */
export function CompanionCallWorkSpinner({
  size,
  still = false,
}: {
  size: number;
  still?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={`shrink-0 ${still ? "" : "companion-work-spin"}`}
      aria-hidden
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="var(--companion-ring-accent)"
        strokeOpacity="0.2"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="var(--companion-ring-accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={still ? undefined : "10 28"}
        strokeOpacity={still ? 0.6 : undefined}
      />
    </svg>
  );
}

/** A finished piece of work's mark, popped in once. */
export function CompanionCallWorkSettled({
  state,
}: {
  state: "done" | "failed";
}) {
  return state === "done" ? (
    <Check
      className="companion-work-pop size-3.5 shrink-0 text-[var(--companion-ring-accent)]"
      aria-hidden
    />
  ) : (
    <X
      className="companion-work-pop size-3.5 shrink-0 text-white/50"
      aria-hidden
    />
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** The current time, ticking each second while mounted. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  return now;
}

/**
 * One line per piece of work: what it is, and what it is doing this moment. A
 * step that changes fades in over the last. Sub-agents carry their elapsed
 * time; the foreground's steps are too short-lived for a clock to mean
 * anything.
 */
export function CompanionCallWorkShelf({
  work,
  accentHex,
}: {
  work: readonly VoiceActivityWork[];
  accentHex: string;
}) {
  const { t } = useTranslation();
  const now = useNow();
  const shown = work.slice(0, CALL_WORK_SHELF_MAX_LINES);
  const more = work.length - shown.length;
  return (
    <div
      className="flex w-full min-w-[300px] flex-col gap-1.5 px-4 py-3 text-[12px] text-white/85"
      style={callWorkAccent(accentHex)}
      data-companion-work-shelf
    >
      {shown.map((item) => (
        <div key={item.id} className="flex items-center gap-2">
          {item.state === "running" || item.state === "waiting" ? (
            <CompanionCallWorkSpinner
              size={14}
              still={item.state === "waiting"}
            />
          ) : (
            <CompanionCallWorkSettled state={item.state} />
          )}
          <span
            className={`max-w-[55%] shrink-0 truncate font-medium ${
              item.state === "done" || item.state === "failed"
                ? "text-white/55"
                : ""
            }`}
          >
            {item.title}
          </span>
          <span
            key={item.state === "running" ? item.step : item.state}
            className="companion-work-fade min-w-0 flex-1 truncate text-white/50"
          >
            {item.state === "running"
              ? item.step
              : item.state === "waiting"
                ? t("companionSurface.workWaitingStep")
                : item.state === "done"
                  ? t("companionSurface.workDone")
                  : t("companionSurface.workStopped")}
          </span>
          {item.kind === "subagent" ? (
            <span className="shrink-0 text-[11px] text-white/40 tabular-nums">
              {formatElapsed(now - item.startedAt)}
            </span>
          ) : null}
        </div>
      ))}
      {more > 0 ? (
        <div className="pl-[22px] text-[11px] text-white/40">
          {t("companionSurface.workMore", { count: more })}
        </div>
      ) : null}
    </div>
  );
}
