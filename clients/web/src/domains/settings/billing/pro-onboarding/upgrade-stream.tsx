import { useEffect, useRef } from "react";

import { renderAvatarSprite } from "@/utils/avatar-sprite";
import { mulberry32 } from "@/utils/avatar-wave-ribbon";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

import {
  buildStreamPath,
  seatRows,
  wrapDistance,
  type StreamPath,
  type StreamPoint,
} from "./upgrade-stream-path";

/**
 * A crowd of characters streaming through the provisioning takeover while
 * the machine upgrades: a thread of small ones drops in through the top,
 * sweeps around the status copy, and pours off the bottom as a broad crowd,
 * the way the welcome screen's wave frames its heading.
 *
 * Unlike the wave, this one keeps moving. Every character advances along
 * the stream, the ones that leave off the bottom come back in at the top,
 * and so the crowd reads as scrolling past for as long as the upgrade runs.
 * Each character moves at a speed proportional to its size, so a row keeps
 * the beat it was given at the head as it grows toward the tail, and the
 * thread trickles while the crowd rolls.
 *
 * Purely decorative and drawn on one canvas; `aria-hidden`. Two layouts:
 * around the copy where there is room beside it, below it where there is
 * not.
 */

/**
 * The stream's centerline against a box that centres its copy. The thread
 * enters through the top edge left of centre, climbs over the copy's right
 * shoulder, drops down its right-hand side, and comes back under it as the
 * crowd, leaving through the bottom edge on the left. Both ends sit well
 * off screen so a character's jump from tail to head is never seen. `fs` is
 * the size ramp, elevenfold head to tail, which reads as depth; it runs
 * large so the crowd is a few big characters rather than many small ones.
 */
const AROUND_STREAM: StreamPoint[] = [
  { fx: 0.2, fy: -0.16, fs: 0.02 },
  { fx: 0.23, fy: 0.0, fs: 0.024 },
  { fx: 0.34, fy: 0.12, fs: 0.03 },
  { fx: 0.52, fy: 0.19, fs: 0.037 },
  { fx: 0.7, fy: 0.26, fs: 0.046 },
  { fx: 0.85, fy: 0.4, fs: 0.058 },
  { fx: 0.88, fy: 0.56, fs: 0.074 },
  { fx: 0.76, fy: 0.71, fs: 0.095 },
  { fx: 0.56, fy: 0.82, fs: 0.12 },
  { fx: 0.4, fy: 0.93, fs: 0.15 },
  { fx: 0.3, fy: 1.08, fs: 0.185 },
  { fx: 0.24, fy: 1.28, fs: 0.22 },
];

/**
 * The stream against a box that sits below the copy, which is what a
 * phone gives it: no room beside the copy, so the copy takes the top of
 * the screen and the stream the rest. The thread enters through the right
 * edge near the top of its box, switches back across it twice as it grows,
 * and pours off the bottom. The box is shorter than a screen, so the ramp
 * is steeper against it to reach the same sizes.
 */
const BELOW_STREAM: StreamPoint[] = [
  { fx: 1.16, fy: 0.0, fs: 0.03 },
  { fx: 0.95, fy: 0.06, fs: 0.036 },
  { fx: 0.68, fy: 0.16, fs: 0.048 },
  { fx: 0.4, fy: 0.3, fs: 0.065 },
  { fx: 0.22, fy: 0.47, fs: 0.09 },
  { fx: 0.32, fy: 0.64, fs: 0.125 },
  { fx: 0.56, fy: 0.8, fs: 0.17 },
  { fx: 0.58, fy: 0.98, fs: 0.22 },
  { fx: 0.46, fy: 1.22, fs: 0.27 },
  { fx: 0.36, fy: 1.5, fs: 0.3 },
];

/** Which composition the crowd flows in; see the two paths above. */
export type StreamLayout = "around" | "below";

const STREAMS: Record<StreamLayout, StreamPoint[]> = {
  around: AROUND_STREAM,
  below: BELOW_STREAM,
};

/**
 * Keeps the widening tail from producing one absurdly large character, per
 * layout: the box below the copy is shorter, so its cap is a larger share.
 */
const MAX_SIZE_FRACTION: Record<StreamLayout, number> = {
  around: 0.24,
  below: 0.32,
};
/** A row every this many local sizes along the stream. */
const ROW_GAP = 0.95;
/** Lane pitch across the stream, in local sizes. */
const LANE_PITCH = 0.95;
/** Sizes a character advances per second at `speed` 1. */
const SIZES_PER_SECOND = 1;
/** Sprites are rasterized per size bucket so growth reuses most of them. */
const SPRITE_SIZE_BUCKET = 8;
const SEED = 20260922;
/** Capped so a backgrounded tab resumes rather than teleporting the crowd. */
const MAX_FRAME_MS = 50;

export type StreamFlow = "down" | "up";

export interface UpgradeStreamProps {
  className?: string;
  /**
   * `around` fills a box the copy is centred in and flows around it;
   * `below` fills a box under the copy and flows across it.
   */
  layout?: StreamLayout;
  /**
   * Which way the crowd moves. `down` follows the path, head to tail, so
   * the small ones at the top grow as they come down; `up` runs it back.
   */
  flow?: StreamFlow;
  /** Multiplier on the pace; 1 is a gentle roll, 0 holds still. */
  speed?: number;
  /** How many characters sit across the stream. */
  lanes?: number;
  /** Holds every character where it is; the idle bob keeps going. */
  paused?: boolean;
}

interface StreamItem {
  /** Distance along the path. The one thing that changes as it flows. */
  distance: number;
  /** Seat across the stream, in lane pitches from the centerline. */
  lane: number;
  /** Per-character jitter, in local sizes, so rows do not read as a grid. */
  jitterAlong: number;
  jitterAcross: number;
  sizeScale: number;
  rotate: number;
  phase: number;
  bodyIdx: number;
  eyeIdx: number;
  colorIdx: number;
}

export function UpgradeStream({
  className = "",
  layout = "around",
  flow = "down",
  speed = 1,
  lanes = 3,
  paused = false,
}: UpgradeStreamProps) {
  const components = useBundledAvatarComponents();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // The pace and the pause are read through a ref so changing them mid-run
  // steers the crowd in place rather than re-seating it.
  const motionRef = useRef({ flow, speed, paused });
  useEffect(() => {
    motionRef.current = { flow, speed, paused };
  }, [flow, speed, paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !components) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let width = 0;
    let height = 0;
    let path: StreamPath | null = null;
    let maxSize = Infinity;
    let items: StreamItem[] = [];
    let lastFrame = 0;
    const spriteCache = new Map<string, HTMLCanvasElement | null>();

    const spriteFor = (item: StreamItem, px: number) => {
      const bucket =
        Math.max(1, Math.round(px / SPRITE_SIZE_BUCKET)) * SPRITE_SIZE_BUCKET;
      const key = `${item.bodyIdx}-${item.eyeIdx}-${item.colorIdx}-${bucket}`;
      const hit = spriteCache.get(key);
      if (hit !== undefined) {
        return hit;
      }
      const made = renderAvatarSprite(
        components,
        item.bodyIdx,
        item.eyeIdx,
        item.colorIdx,
        bucket,
      );
      spriteCache.set(key, made);
      return made;
    };

    /**
     * Seat the crowd afresh for the box. Seating is deterministic for the
     * seed, so a resize reproduces the same crowd rather than reshuffling
     * it; only the distances already travelled are carried across, so a
     * resize mid-stream does not snap everyone back to their seats.
     */
    const seat = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }
      if (
        Math.abs(rect.width - width) < 1 &&
        Math.abs(rect.height - height) < 1
      ) {
        return;
      }
      const previous = path;
      const travelled = items.map((item) => item.distance);
      width = rect.width;
      height = rect.height;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      path = buildStreamPath(STREAMS[layout], width, height);
      maxSize = height * MAX_SIZE_FRACTION[layout];

      const rng = mulberry32(SEED);
      const jitter = (amount: number) => (rng() * 2 - 1) * amount;
      let lastColor = -1;
      items = [];
      seatRows(path, ROW_GAP).forEach((distance, row) => {
        // Alternate rows shift half a lane so the packing nests instead of
        // forming parallel strands.
        const rowShift = row % 2 === 0 ? 0 : 0.5;
        for (let k = 0; k < lanes; k++) {
          let colorIdx = Math.floor(rng() * components.colors.length);
          if (colorIdx === lastColor) {
            colorIdx = (colorIdx + 1) % components.colors.length;
          }
          lastColor = colorIdx;
          items.push({
            distance,
            lane: k - (lanes - 1) / 2 + rowShift,
            jitterAlong: jitter(0.08),
            jitterAcross: jitter(0.12),
            sizeScale: 0.85 + rng() * 0.3,
            rotate: (jitter(10) * Math.PI) / 180,
            phase: rng() * Math.PI * 2,
            bodyIdx: Math.floor(rng() * components.bodyShapes.length),
            eyeIdx: Math.floor(rng() * components.eyeStyles.length),
            colorIdx,
          });
        }
      });

      // Carry the flow across a resize: each seat keeps the fraction of
      // the path it had reached, as far as the seats line up.
      if (previous && previous.length > 0) {
        const scale = path.length / previous.length;
        items.forEach((item, index) => {
          const before = travelled[index];
          if (before !== undefined) {
            item.distance = wrapDistance(before * scale, path!.length);
          }
        });
      }
    };

    const draw = (now: number) => {
      if (!path) {
        return;
      }
      const dtMs = lastFrame ? Math.min(MAX_FRAME_MS, now - lastFrame) : 0;
      lastFrame = now;
      const { flow: dir, speed: pace, paused: held } = motionRef.current;
      const advance =
        reduce || held
          ? 0
          : (dir === "down" ? 1 : -1) * pace * SIZES_PER_SECOND * (dtMs / 1000);

      ctx.clearRect(0, 0, width, height);
      for (const item of items) {
        if (advance !== 0) {
          // Speed follows the local size: the thread trickles, the crowd
          // rolls, and the spacing each row was seated with survives the
          // whole way down.
          const here = path.at(item.distance).size;
          item.distance = wrapDistance(
            item.distance + advance * here,
            path.length,
          );
        }
        const sample = path.at(item.distance);
        const size = Math.min(maxSize, sample.size * item.sizeScale);
        const across =
          (item.lane * LANE_PITCH + item.jitterAcross) * sample.size;
        const along = item.jitterAlong * sample.size;
        // The perpendicular, to the path's right as it is walked.
        const px = sample.x + sample.ty * across + sample.tx * along;
        const py = sample.y - sample.tx * across + sample.ty * along;

        const sprite = spriteFor(item, size);
        if (!sprite) {
          continue;
        }
        const bob = reduce ? 0 : Math.sin(now * 0.001 + item.phase) * 1.4;
        const wobble = reduce
          ? 0
          : Math.sin(now * 0.0008 + item.phase * 2) * 0.025;

        ctx.save();
        ctx.translate(px, py + bob);
        ctx.rotate(item.rotate + wobble);
        ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
        ctx.restore();
      }
    };

    seat();

    const resizeObserver = new ResizeObserver(() => {
      seat();
      if (reduce) {
        draw(performance.now());
      }
    });
    resizeObserver.observe(canvas);

    let raf = 0;
    if (reduce) {
      draw(performance.now());
    } else {
      const tick = (now: number) => {
        draw(now);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
    };
  }, [components, lanes, layout]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="upgrade-stream"
      className={`pointer-events-none block h-full w-full ${className}`}
    />
  );
}
