import type { JSX } from "react";
import { useEffect, useState } from "react";

export interface RadarBlip {
  readonly id: string;
  /** Distance from center, 0..1. */
  readonly distance: number;
  /** Polar angle in degrees, 0..360. */
  readonly angle: number;
  /** Wall-clock ms when the blip was added. */
  readonly createdAt: number;
  readonly label?: string;
}

interface PerceptionRadarProps {
  readonly blips: readonly RadarBlip[];
  /** Optional ms TTL after which blips fade out. */
  readonly ttlMs?: number;
}

/**
 * Holographic radar/sonar display. Each `blip` represents a perception
 * event (focused window, host action, voice frame). We render them on a
 * polar grid; blips older than `ttlMs` linearly fade their opacity to
 * give the classic sonar-decay feel.
 */
export function PerceptionRadar({
  blips,
  ttlMs = 8_000,
}: PerceptionRadarProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="radar" aria-hidden>
      <div className="radar-sweep" />
      {blips.map((blip) => {
        const age = now - blip.createdAt;
        const fade = Math.max(0, 1 - age / ttlMs);
        if (fade <= 0) return null;
        const rad = (blip.angle * Math.PI) / 180;
        const x = 50 + Math.cos(rad) * blip.distance * 46;
        const y = 50 + Math.sin(rad) * blip.distance * 46;
        return (
          <div
            key={blip.id}
            className="radar-blip"
            style={{
              left: `${x}%`,
              top: `${y}%`,
              opacity: 0.35 + fade * 0.65,
            }}
            title={blip.label}
          />
        );
      })}
    </div>
  );
}
