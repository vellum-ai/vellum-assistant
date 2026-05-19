import type { JSX } from "react";
import { useEffect, useState } from "react";

/**
 * Header clock + pseudo nav-coords. We pull real wall-clock time (HH:MM:SS),
 * the day-of-year ordinal, and synthesise stable-looking 6-figure coords from
 * the user's locale offset. This is purely aesthetic — meant to evoke a
 * mission-control overlay rather than transmit any real geolocation.
 */
export function ClockDisplay(): JSX.Element {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 500);
    return () => clearInterval(id);
  }, []);

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");

  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - start.getTime();
  const ordinal = String(Math.floor(diff / 86_400_000)).padStart(3, "0");
  const year = String(now.getFullYear()).slice(-2);

  const offset = -now.getTimezoneOffset() / 60;
  const lat = (37 + Math.sin(now.getMinutes() / 9) * 1.4).toFixed(4);
  const lon = (-122 + Math.sin(now.getSeconds() / 17) * 1.2).toFixed(4);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="clock-digits glitch">
        {hh}
        <span className="opacity-60">:</span>
        {mm}
        <span className="opacity-60">:</span>
        {ss}
      </div>
      <div className="flex items-center gap-3 font-display text-[8px] tracking-[0.42em] text-hud-mute">
        <span>
          DOY {ordinal}/{year}
        </span>
        <span>UTC{offset >= 0 ? `+${offset}` : offset}</span>
      </div>
      <div className="font-mono text-[10px] tracking-[0.18em] text-hud-accent/70">
        {lat}°N · {lon}°W
      </div>
    </div>
  );
}
