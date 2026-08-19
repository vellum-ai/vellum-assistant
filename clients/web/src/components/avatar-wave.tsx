import { useEffect, useRef } from "react";

import {
  buildRibbonWave,
  mulberry32,
  resolveRibbon,
  ribbonSizingHeight,
  type RelativeRibbonPoint,
  type RibbonPoint,
} from "@/utils/avatar-wave-ribbon";
import type { CharacterComponents } from "@/types/avatar";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

/**
 * A crowd of characters flowing down a ribbon, drawn on one canvas and
 * simulated per frame: they lean away from the cursor, a quick swipe knocks
 * nearby ones loose to sail off and bounce around, and everything springs
 * back home once it settles.
 *
 * Purely decorative. The canvas never takes pointer events, and the cursor
 * is tracked on `window` so the characters still react while the pointer is
 * over the content sitting beside them.
 */

/**
 * Design-space box the column ribbon is authored in. The canvas scales this
 * to cover its container, so the crowd keeps its shape at any panel size.
 */
const DESIGN_W = 620;
const DESIGN_H = 900;

const SEED = 20260807;

/** Keeps the widening tail from producing one absurdly large character. */
const MAX_AVATAR_SIZE = 165;

/**
 * The column ribbon enters cut off by the top edge as a thin thread of small
 * characters, switches back across the panel three times, and broadens into
 * a full crowd that pours off the bottom.
 *
 * Two ramps do the work, and they are deliberately different. `s` grows
 * about tenfold from head to tail, which reads as depth. `w` grows about
 * thirtyfold, and since a row holds `w / s` characters, that difference is
 * what turns a two-wide thread at the top into a six-wide crowd at the
 * bottom. Widening the two together would keep the row count flat however
 * large the characters got.
 *
 * The centerline drifts back toward the middle as `w` overtakes the panel,
 * so the broad rows bleed off the outer edge rather than being sliced by
 * the inner one.
 */
const COLUMN_RIBBON: RibbonPoint[] = [
  { x: 330, y: -70, w: 26, s: 13 },
  { x: 420, y: 20, w: 40, s: 18 },
  { x: 482, y: 115, w: 62, s: 25 },
  { x: 458, y: 215, w: 96, s: 34 },
  { x: 368, y: 298, w: 140, s: 45 },
  { x: 258, y: 372, w: 196, s: 57 },
  { x: 208, y: 462, w: 262, s: 70 },
  { x: 262, y: 556, w: 340, s: 84 },
  { x: 352, y: 642, w: 430, s: 98 },
  { x: 372, y: 730, w: 530, s: 112 },
  { x: 340, y: 822, w: 620, s: 124 },
  { x: 360, y: 912, w: 700, s: 132 },
  { x: 380, y: 1002, w: 760, s: 140 },
];

/**
 * The wrap ribbon is the same crowd on a screen with no column to spare: it
 * goes around the content instead of beside it. A thread of small characters
 * drops in through the top edge near the left, turns and sweeps right over
 * the heading, carries on down past its outer edge and off the screen, then
 * comes back in below the buttons, where it broadens into the crowd that
 * fills the rest of the screen.
 *
 * The loop between `fx: 1.0` and the re-entry is drawn but never seen. It
 * exists so the thread that leaves and the crowd that returns are one
 * continuous path with a continuous size ramp, rather than two pieces that
 * happen to line up at the edge.
 *
 * The two clearances the thread and the crowd have to hold are the heading's
 * top and the second button's bottom. A step's column is a fixed stack of
 * text and controls centred in what the bottom padding leaves it, so it
 * keeps its height as the screen shortens and takes a larger fraction of it:
 * the shortest screen the wrap runs on is the one that binds, and both
 * clearances are tuned against a 640-tall phone rather than an 844-tall one.
 * See {@link RelativeRibbonPoint} for why this ribbon is authored against
 * the screen and the column one is not.
 */
const WRAP_RIBBON: RelativeRibbonPoint[] = [
  { fx: 0.11, fy: -0.15, fw: 0.05, fs: 0.0112 },
  { fx: 0.115, fy: -0.06, fw: 0.055, fs: 0.0126 },
  { fx: 0.14, fy: 0.012, fw: 0.062, fs: 0.0142 },
  { fx: 0.21, fy: 0.055, fw: 0.07, fs: 0.016 },
  { fx: 0.34, fy: 0.072, fw: 0.077, fs: 0.0178 },
  { fx: 0.51, fy: 0.072, fw: 0.084, fs: 0.0195 },
  { fx: 0.7, fy: 0.08, fw: 0.091, fs: 0.0212 },
  { fx: 0.89, fy: 0.112, fw: 0.1, fs: 0.023 },
  { fx: 1.05, fy: 0.174, fw: 0.114, fs: 0.026 },
  { fx: 1.15, fy: 0.28, fw: 0.142, fs: 0.0316 },
  { fx: 1.19, fy: 0.4, fw: 0.18, fs: 0.0392 },
  { fx: 1.14, fy: 0.55, fw: 0.228, fs: 0.0476 },
  { fx: 0.98, fy: 0.702, fw: 0.325, fs: 0.0586 },
  { fx: 0.74, fy: 0.796, fw: 0.51, fs: 0.0724 },
  { fx: 0.58, fy: 0.866, fw: 0.84, fs: 0.0874 },
  { fx: 0.52, fy: 0.93, fw: 1.16, fs: 0.1004 },
  { fx: 0.5, fy: 0.998, fw: 1.48, fs: 0.1124 },
  { fx: 0.5, fy: 1.07, fw: 1.8, fs: 0.1224 },
];

/**
 * {@link MAX_AVATAR_SIZE}'s counterpart, against the same height the ribbon
 * sizes its avatars from. Reading it off the raw height instead would undo
 * {@link ribbonSizingHeight} on exactly the boxes it exists for: the cap
 * would clip the scaled-up avatars back down, leaving the crowd to pack
 * itself several times over.
 */
const WRAP_MAX_AVATAR_FRACTION = 0.135;

/**
 * Shortest box the wrap composition is offered on. It holds the top fifth
 * for the thread and the bottom third for the crowd, so a shorter box has
 * nowhere left to put the content between them, and the heading ends up
 * under the thread whatever the step. Below this the layout falls back to
 * the creature footer.
 */
export const WRAP_WAVE_MIN_HEIGHT_QUERY = "(min-height: 600px)";

const REPEL_RADIUS = 170;
const REPEL_PUSH = 70;
/** Kick impulse per frame per unit of cursor velocity. */
const FLING = 2;
/** Speed at which a character detaches and sails off, immune from there on. */
const BALLISTIC_ON = 5;
const MAX_SPEED = 17;
const FLIGHT_FRICTION = 0.972;
const BOUNCE = 0.84;
/** Displacement past which a merely-nudged character also goes immune. */
const DISTURB_DIST = 70;
const STIFF_BACK = 0.06;
const DAMP_BACK = 0.85;
const STIFF_HOVER = 0.12;
const DAMP_HOVER = 0.74;
/** Cursor speed is clamped before it becomes an impulse. */
const MAX_CURSOR_SPEED = 8;

const REVEAL_MS = 550;
/**
 * Relative gap between one character's entrance and the next: small ones at
 * the head of the ribbon follow each other quickly, large ones at the tail
 * arrive with a beat between them. These are weights, not milliseconds —
 * they are normalized to {@link POUR_TOTAL_MS} so that reshaping the ribbon
 * changes the wave's look without changing how long it takes to arrive.
 */
const POUR_GAP_MIN = 12;
const POUR_GAP_MAX = 55;
const POUR_GAP_NUMERATOR = 1900;
/** How long the whole crowd takes to finish pouring in. */
const POUR_TOTAL_MS = 1600;

/**
 * The simulation is tuned in 60fps frames, so every integration step scales
 * by how long the real frame took. Without this the wave springs and flies
 * at double speed on a 120Hz display. Capped so returning to a backgrounded
 * tab resumes rather than teleporting everything.
 */
const FRAME_MS = 1000 / 60;
const MAX_FRAME_SCALE = 3;

/** Idle decay so a stationary cursor stops flinging on its last reading. */
const CURSOR_VELOCITY_DECAY = 0.9;

/** Sprites are rasterized per size bucket so a resize reuses most of them. */
const SPRITE_SIZE_BUCKET = 8;

interface LiveItem {
  /** Home position and drawn size, in canvas pixels. */
  hx: number;
  hy: number;
  px: number;
  rotate: number;
  phase: number;
  pourDelay: number;
  /** Offset from home, velocity, and disturbance mode. */
  dx: number;
  dy: number;
  vx: number;
  vy: number;
  disturbed: boolean;
  flying: boolean;
  fade: number;
  sprite: HTMLCanvasElement | null;
}

/**
 * Draw one character to an offscreen canvas at its final size. Rasterizing
 * once per character keeps the per-frame cost to a `drawImage` each, which
 * is what lets the whole crowd run at frame rate.
 */
function renderSprite(
  components: CharacterComponents,
  bodyIdx: number,
  eyeIdx: number,
  colorIdx: number,
  px: number,
): HTMLCanvasElement | null {
  const body = components.bodyShapes[bodyIdx];
  const eye = components.eyeStyles[eyeIdx];
  const color = components.colors[colorIdx];
  if (!body || !eye || !color) {
    return null;
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const sprite = document.createElement("canvas");
  sprite.width = Math.max(2, Math.ceil(px * dpr));
  sprite.height = sprite.width;
  const ctx = sprite.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.scale(dpr, dpr);

  const bodyBox = body.viewBox;
  const bodyScale = Math.min(px / bodyBox.width, px / bodyBox.height);
  const bodyTx = (px - bodyBox.width * bodyScale) / 2;
  const bodyTy = (px - bodyBox.height * bodyScale) / 2;
  ctx.save();
  ctx.translate(bodyTx, bodyTy);
  ctx.scale(bodyScale, bodyScale);
  ctx.fillStyle = color.hex;
  ctx.fill(new Path2D(body.svgPath));
  ctx.restore();

  const override = components.faceCenterOverrides.find(
    (o) => o.bodyShape === body.id && o.eyeStyle === eye.id,
  );
  const faceCenter = override ? override.faceCenter : body.faceCenter;
  const eyeBox = eye.sourceViewBox;
  const remapScale = Math.min(
    bodyBox.width / eyeBox.width,
    bodyBox.height / eyeBox.height,
  );
  ctx.save();
  ctx.translate(
    bodyScale * (faceCenter.x - eye.eyeCenter.x * remapScale) + bodyTx,
    bodyScale * (faceCenter.y - eye.eyeCenter.y * remapScale) + bodyTy,
  );
  ctx.scale(bodyScale * remapScale, bodyScale * remapScale);
  for (const path of eye.paths) {
    ctx.fillStyle = path.color;
    ctx.fill(new Path2D(path.svgPath));
  }
  ctx.restore();

  return sprite;
}

/**
 * Whether the entrance has already played somewhere in this session. The
 * wave sits behind a run of screens that each mount their own copy, and
 * replaying the pour on every step reads as the page restarting rather than
 * as the same wave carrying through. One pour per visit, then it is simply
 * there.
 */
let hasPlayedEntrance = false;

/**
 * Which composition the crowd is laid out in.
 *
 * `column` fills a panel beside the content: the split the welcome screen
 * takes once there is room for one. `wrap` fills the whole screen behind the
 * content, going around it, which is what a phone gets instead of the split.
 */
export type AvatarWaveVariant = "column" | "wrap";

interface AvatarWaveProps {
  className?: string;
  /**
   * Ask for the staggered entrance. Honored only on the first wave to mount
   * in a session; later ones render settled however they are configured, so
   * a screen that requests it does not have to know whether the user has
   * already come past one.
   */
  entrance?: boolean;
  variant?: AvatarWaveVariant;
}

export function AvatarWave({
  className = "",
  entrance = false,
  variant = "column",
}: AvatarWaveProps) {
  const components = useBundledAvatarComponents();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

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
    const pour = entrance && !reduce && !hasPlayedEntrance;
    if (pour) {
      hasPlayedEntrance = true;
    }

    let width = 0;
    let height = 0;
    let items: LiveItem[] = [];
    let pourStart = 0;
    let lastFrame = 0;
    const cursor = { x: 0, y: 0, vx: 0, vy: 0, active: false };
    let lastMove: { x: number; y: number; t: number } | null = null;
    const spriteCache = new Map<string, HTMLCanvasElement | null>();

    const spriteFor = (
      bodyIdx: number,
      eyeIdx: number,
      colorIdx: number,
      px: number,
    ): HTMLCanvasElement | null => {
      const bucket =
        Math.max(1, Math.round(px / SPRITE_SIZE_BUCKET)) * SPRITE_SIZE_BUCKET;
      const key = `${bodyIdx}-${eyeIdx}-${colorIdx}-${bucket}`;
      const hit = spriteCache.get(key);
      if (hit !== undefined) {
        return hit;
      }
      const made = renderSprite(components, bodyIdx, eyeIdx, colorIdx, bucket);
      spriteCache.set(key, made);
      return made;
    };

    const layout = () => {
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
      width = rect.width;
      height = rect.height;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // The wrap ribbon is authored against the canvas, so resolving it
      // already lands in canvas pixels and the design-box transform below is
      // the identity. The column one is authored in a fixed design box and
      // covers the panel so the ribbon always reaches every edge. Covering
      // means the design is at least as wide as the panel, so there is
      // always horizontal overflow to place. Pin it to the inner edge and
      // let all of that overflow run off the outer one: this panel sits
      // flush against the side of the window, so overflow there leaves the
      // screen, while overflow at the inner edge would slice the crowd in
      // half along the boundary with the content beside it.
      const wrap = variant === "wrap";
      const offsetX = 0;
      const scale = wrap ? 1 : Math.max(width / DESIGN_W, height / DESIGN_H);
      const offsetY = wrap ? 0 : (height - DESIGN_H * scale) / 2;

      const placements = wrap
        ? buildRibbonWave(
            resolveRibbon(WRAP_RIBBON, width, height),
            SEED,
            ribbonSizingHeight(width, height) * WRAP_MAX_AVATAR_FRACTION,
          )
        : buildRibbonWave(COLUMN_RIBBON, SEED, MAX_AVATAR_SIZE);

      // Normalize the size-weighted stagger to a fixed total so the crowd
      // always finishes arriving at the same moment, however many characters
      // the ribbon happens to pack.
      const gapWeight = (size: number) =>
        Math.min(POUR_GAP_MAX, Math.max(POUR_GAP_MIN, POUR_GAP_NUMERATOR / size));
      const weightTotal = placements.reduce(
        (sum, placed) => sum + gapWeight(placed.size),
        0,
      );
      const pourRate = weightTotal > 0 ? POUR_TOTAL_MS / weightTotal : 0;

      const rng = mulberry32(SEED + 1);
      let lastColor = -1;
      let pourDelay = 0;
      items = placements.map(
        (placed): LiveItem => {
          let colorIdx = Math.floor(rng() * components.colors.length);
          if (colorIdx === lastColor) {
            colorIdx = (colorIdx + 1) % components.colors.length;
          }
          lastColor = colorIdx;
          const bodyIdx = Math.floor(rng() * components.bodyShapes.length);
          const eyeIdx = Math.floor(rng() * components.eyeStyles.length);
          const px = placed.size * scale;
          const item: LiveItem = {
            hx: offsetX + placed.x * scale,
            hy: offsetY + placed.y * scale,
            px,
            rotate: (placed.rotate * Math.PI) / 180,
            phase: rng() * Math.PI * 2,
            pourDelay,
            dx: 0,
            dy: 0,
            vx: 0,
            vy: 0,
            disturbed: false,
            flying: false,
            fade: 1,
            sprite: spriteFor(bodyIdx, eyeIdx, colorIdx, px),
          };
          pourDelay += gapWeight(placed.size) * pourRate;
          return item;
        },
      );
      if (pourStart === 0) {
        pourStart = performance.now();
      }
    };

    const step = (item: LiveItem, frames: number) => {
      const posX = item.hx + item.dx;
      const posY = item.hy + item.dy;

      if (item.flying) {
        const friction = Math.pow(FLIGHT_FRICTION, frames);
        item.vx *= friction;
        item.vy *= friction;
        item.dx += item.vx * frames;
        item.dy += item.vy * frames;

        const half = item.px / 2;
        const minX = half;
        const maxX = width - half;
        const minY = half;
        const maxY = height - half;
        const cx = item.hx + item.dx;
        const cy = item.hy + item.dy;
        if (maxX > minX) {
          if (cx < minX) {
            item.dx = minX - item.hx;
            item.vx = Math.abs(item.vx) * BOUNCE;
          } else if (cx > maxX) {
            item.dx = maxX - item.hx;
            item.vx = -Math.abs(item.vx) * BOUNCE;
          }
        }
        if (maxY > minY) {
          if (cy < minY) {
            item.dy = minY - item.hy;
            item.vy = Math.abs(item.vy) * BOUNCE;
          } else if (cy > maxY) {
            item.dy = maxY - item.hy;
            item.vy = -Math.abs(item.vy) * BOUNCE;
          }
        }
        if (Math.hypot(item.vx, item.vy) < 0.7) {
          item.flying = false;
        }
        return;
      }

      if (item.disturbed) {
        // Immune to the cursor until it has settled back home.
        const damp = Math.pow(DAMP_BACK, frames);
        item.vx = (item.vx - item.dx * STIFF_BACK * frames) * damp;
        item.dx += item.vx * frames;
        item.vy = (item.vy - item.dy * STIFF_BACK * frames) * damp;
        item.dy += item.vy * frames;
        if (
          Math.hypot(item.dx, item.dy) < 2 &&
          Math.hypot(item.vx, item.vy) < 0.25
        ) {
          item.disturbed = false;
        }
        return;
      }

      let targetX = 0;
      let targetY = 0;
      if (cursor.active) {
        const awayX = posX - cursor.x;
        const awayY = posY - cursor.y;
        const dist = Math.hypot(awayX, awayY) || 1;
        if (dist < REPEL_RADIUS) {
          const falloff = 1 - dist / REPEL_RADIUS;
          targetX = (awayX / dist) * Math.pow(falloff, 1.4) * REPEL_PUSH;
          targetY = (awayY / dist) * Math.pow(falloff, 1.4) * REPEL_PUSH;
          item.vx += cursor.vx * falloff * FLING * frames;
          item.vy += cursor.vy * falloff * FLING * frames;
          const speed = Math.hypot(item.vx, item.vy);
          if (speed > MAX_SPEED) {
            item.vx = (item.vx / speed) * MAX_SPEED;
            item.vy = (item.vy / speed) * MAX_SPEED;
          }
          if (speed > BALLISTIC_ON) {
            item.flying = true;
            item.disturbed = true;
            return;
          }
        }
      }

      const displacing = targetX !== 0 || targetY !== 0;
      const stiff = (displacing ? STIFF_HOVER : STIFF_BACK) * frames;
      const damp = Math.pow(displacing ? DAMP_HOVER : DAMP_BACK, frames);
      item.vx = (item.vx + (targetX - item.dx) * stiff) * damp;
      item.dx += item.vx * frames;
      item.vy = (item.vy + (targetY - item.dy) * stiff) * damp;
      item.dy += item.vy * frames;
      if (Math.hypot(item.dx, item.dy) > DISTURB_DIST) {
        item.disturbed = true;
      }
    };

    const draw = (now: number) => {
      const frames = lastFrame
        ? Math.min(MAX_FRAME_SCALE, (now - lastFrame) / FRAME_MS)
        : 1;
      lastFrame = now;
      if (!reduce) {
        // The cursor's velocity only updates on movement, so bleed it off
        // here; otherwise a pointer that stops inside the field keeps
        // flinging characters with its last reading forever.
        const decay = Math.pow(CURSOR_VELOCITY_DECAY, frames);
        cursor.vx *= decay;
        cursor.vy *= decay;
      }

      ctx.clearRect(0, 0, width, height);
      for (const item of items) {
        const sprite = item.sprite;
        if (!sprite) {
          continue;
        }

        let revealScale = 1;
        let revealAlpha = 1;
        let revealDrop = 0;
        if (!reduce) {
          if (pour) {
            const elapsed = now - pourStart - item.pourDelay;
            if (elapsed < 0) {
              continue;
            }
            const p = Math.min(1, elapsed / REVEAL_MS);
            if (p < 1) {
              const eased =
                1 + 2.2 * Math.pow(p - 1, 3) + 1.2 * Math.pow(p - 1, 2);
              revealScale =
                0.3 +
                0.7 * Math.min(1.04, eased + 0.04 * Math.sin(p * Math.PI));
              revealAlpha = Math.min(1, p * 2.2);
              revealDrop = (1 - p) * -60;
            }
          }
          step(item, frames);
          const away = Math.hypot(item.dx, item.dy);
          const targetFade = item.flying ? 0.88 : away > 20 ? 0.92 : 1;
          item.fade += (targetFade - item.fade) * Math.min(1, 0.08 * frames);
        }

        const bob = reduce ? 0 : Math.sin(now * 0.001 + item.phase) * 1.4;
        const wobble = reduce
          ? 0
          : Math.sin(now * 0.0008 + item.phase * 2) * 0.025;
        const size = item.px * revealScale;

        ctx.save();
        ctx.translate(
          item.hx + item.dx,
          item.hy + item.dy + bob + revealDrop,
        );
        ctx.rotate(item.rotate + wobble);
        ctx.globalAlpha = item.fade * revealAlpha;
        ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
        ctx.restore();
      }
    };

    layout();

    const resizeObserver = new ResizeObserver(() => {
      layout();
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

    const setCursor = (clientX: number, clientY: number) => {
      const now = performance.now();
      if (lastMove) {
        const dt = Math.max(1, now - lastMove.t);
        let vx = cursor.vx * 0.5 + ((clientX - lastMove.x) / dt) * 0.5;
        let vy = cursor.vy * 0.5 + ((clientY - lastMove.y) / dt) * 0.5;
        const speed = Math.hypot(vx, vy);
        if (speed > MAX_CURSOR_SPEED) {
          vx = (vx / speed) * MAX_CURSOR_SPEED;
          vy = (vy / speed) * MAX_CURSOR_SPEED;
        }
        cursor.vx = vx;
        cursor.vy = vy;
      }
      lastMove = { x: clientX, y: clientY, t: now };
      const rect = canvas.getBoundingClientRect();
      cursor.x = clientX - rect.left;
      cursor.y = clientY - rect.top;
      cursor.active = true;
    };
    const onMove = (e: MouseEvent) => setCursor(e.clientX, e.clientY);
    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch) {
        setCursor(touch.clientX, touch.clientY);
      }
    };
    const onLeave = () => {
      cursor.active = false;
      cursor.vx = 0;
      cursor.vy = 0;
      lastMove = null;
    };

    if (!reduce) {
      window.addEventListener("mousemove", onMove, { passive: true });
      window.addEventListener("mouseout", onLeave);
      window.addEventListener("touchmove", onTouchMove, { passive: true });
      window.addEventListener("touchend", onLeave);
      window.addEventListener("touchcancel", onLeave);
    }

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onLeave);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onLeave);
      window.removeEventListener("touchcancel", onLeave);
    };
  }, [components, entrance, variant]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none block h-full w-full ${className}`}
    />
  );
}
