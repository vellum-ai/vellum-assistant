/**
 * The color look for the voice room — the onboarding "avatar is the screen"
 * treatment reused for character avatars.
 *
 * `resolveVoiceRoomLook` maps the assistant's avatar data to the look; the
 * {@link VoiceRoomColorLook} component plays the onboarding Introduction
 * step's entrance on mount, so opening the room reads as the avatar growing
 * from "on the screen" to BEING the screen:
 *
 * 1. the room starts on a dark surface,
 * 2. the avatar's body shape springs from its small on-screen size up to
 *    cover the viewport end to end,
 * 3. the matching color layer fades in behind it (covering the body shape's
 *    gaps/spikes),
 * 4. the giant eyes grow into their rest position (bottom-edge or centered,
 *    per `eyePlacement`) with a settle dip, then a double blink and idle-blink
 *    from there (with a slight cursor parallax).
 *
 * Per-state treatments (driven by `visual`, cross-faded so nothing pops):
 * while the user speaks (`listening`) the mic-amplitude waveform swells behind
 * the eyes — centered by default so it reads as the voice gathering around them
 * rather than rising from the floor — and the eyes drop to a low hold. When the
 * turn passes to the assistant they ride back up to center: `thinking`
 * dissolves the waves out and a quiet dot triad in just above the eyes, then
 * `responding` keeps them centered while the assistant's voice radiates outward
 * from behind them (see {@link VoiceRespondingStyle}). `reconnecting` fades the
 * eyes back — presence dimmed while away.
 *
 * Geometry and timing mirror onboarding's `IntroductionScreen` +
 * `OnboardingPeekingEyes`. Traits default like `ChatAvatar` does (first
 * component of each type), so a default-character assistant gets the same
 * color and eyes the user sees in its small avatar. Custom-image /
 * no-character avatars resolve to `null` and the room falls back to its
 * ambient-void look — what that look should become is an open design
 * question.
 *
 * Decorative: `aria-hidden`, `pointer-events-none`, reduced-motion safe (no
 * entrance, no parallax; the blink is a discrete squish, kept). Sized against
 * the window — the room is a `fixed inset-0` overlay, so the window IS its
 * box — unless a `viewport` override is passed (Storybook renders in a box).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { pathBBox, unionBBox, type BBox } from "@/components/avatar/eye-bbox";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

import {
  VoiceListeningWaves,
  type VoiceWavePalette,
  type VoiceWavePlacement,
  type VoiceWaveStyle,
} from "./voice-listening-waves";
import type { VoiceAvatarVisual } from "./voice-avatar-state";
import { createAmplitudeSmoother } from "./voice-motion";

/** Where the eyes come to rest: cut off at the bottom edge, or centered. */
export type VoiceEyePlacement = "bottom" | "center";

/** How much of the bottom-placed eyes sits below the edge at rest. */
const EYE_REST_CUTOFF = 0.25;
/** Eye sizing: height at most 30% of the smaller viewport dimension, capped
 *  so width stays on-screen. */
const EYE_TARGET_HEIGHT = 0.3;
const EYE_MAX_WIDTH = 0.85;
/** Slight whole-eye cursor parallax. */
const CURSOR_MAX_X = 14;
const CURSOR_MAX_Y = 8;
/**
 * How far down the centered eyes hold while listening, as a fraction of the
 * sink travel to the bottom rest — they settle low (clear of the centered
 * waveform) the moment the user starts, and the remaining fraction is the
 * live bob driven by mic amplitude, so they never float back up between words.
 */
const EYE_LISTEN_SINK_BASE = 0.85;
/**
 * How long the eyes travel between center and the low listening hold — a
 * motion tween on the hold wrapper (the same animation system as the entrance
 * keyframes; see {@link VoiceRoomEyes}). The drop is quicker than the rise:
 * getting out of the waveform's way is urgent, coming back up is composed.
 */
const EYE_SINK_MS = 450;
const EYE_RISE_MS = 700;
/** The entrance grows the body from this "avatar on the screen" size and the
 *  eyes from this vertical center — onboarding's picker geometry. */
const ENTER_FROM_SIZE = 200;
const ENTER_FROM_CENTER_VH = 40;
/** The room's own dark base, under the color fade (matches the ambient look's
 *  deep surface so the first frames read the same for both looks). */
const DARK_SURFACE = "#17191C";

export interface VoiceRoomEyeArt {
  paths: { svgPath: string; color: string }[];
  bbox: BBox;
}

export interface VoiceRoomLook {
  /** The avatar color that fills the room. */
  bgHex: string;
  /** The avatar's eye art, sized/framed by its union bounding box. */
  art: VoiceRoomEyeArt;
  /** The avatar's body shape, grown to cover the screen on entrance. */
  body: { svgPath: string; viewBox: { width: number; height: number } } | null;
}

/**
 * Resolve the room's color-with-eyes look from the session assistant's avatar
 * data, or `null` when the assistant has no character to draw (custom-image /
 * "none" avatars, or components/traits still loading) — the caller then keeps
 * the ambient-void look.
 */
export function resolveVoiceRoomLook(
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
  customImageUrl: string | null,
): VoiceRoomLook | null {
  if (!components) return null;
  // A custom uploaded image with no traits renders as the image avatar, not a
  // character — same precedence as ChatAvatar's `preferCharacter`.
  if (!traits && customImageUrl) return null;
  const effectiveTraits =
    traits ??
    (components.bodyShapes[0] && components.eyeStyles[0] && components.colors[0]
      ? {
          bodyShape: components.bodyShapes[0].id,
          eyeStyle: components.eyeStyles[0].id,
          color: components.colors[0].id,
        }
      : null);
  if (!effectiveTraits) return null;
  const eyeDef = components.eyeStyles.find(
    (e) => e.id === effectiveTraits.eyeStyle,
  );
  const bgHex = components.colors.find(
    (c) => c.id === effectiveTraits.color,
  )?.hex;
  if (!eyeDef || eyeDef.paths.length === 0 || !bgHex) return null;
  const bbox = unionBBox(eyeDef.paths.map((p) => pathBBox(p.svgPath)));
  // Degenerate art (empty paths) would make the sizing math divide by zero.
  if (bbox.w <= 0 || bbox.h <= 0) return null;
  const bodyDef = components.bodyShapes.find(
    (b) => b.id === effectiveTraits.bodyShape,
  );
  const body =
    bodyDef && bodyDef.viewBox.width > 0 && bodyDef.viewBox.height > 0
      ? { svgPath: bodyDef.svgPath, viewBox: bodyDef.viewBox }
      : null;
  return { bgHex, art: { paths: eyeDef.paths, bbox }, body };
}

/**
 * The on-screen height of the eyes in a `w`×`h` room — capped at
 * `EYE_TARGET_HEIGHT` of the smaller dimension, then clamped so the width stays
 * within `EYE_MAX_WIDTH`. Shared so the thinking dots can sit just above the
 * centered eyes without re-deriving the sizing from the art bbox.
 */
function eyeDisplayHeight(art: VoiceRoomEyeArt, w: number, h: number): number {
  const maxEyesW = w * EYE_MAX_WIDTH;
  return Math.min(
    Math.min(w, h) * EYE_TARGET_HEIGHT,
    (maxEyesW * art.bbox.h) / art.bbox.w,
  );
}

function windowSize(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}

/** The window box, kept live on resize — the room is a full-viewport overlay. */
function useViewportSize(): { w: number; h: number } {
  const [size, setSize] = useState(windowSize);
  useEffect(() => {
    const onResize = () => setSize(windowSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/**
 * The full color look: dark base, screen-covering body grow, color fade,
 * listening waves, peeking eyes. Mount = session start (the room only mounts
 * once per session), so mounting plays the entrance.
 */
export function VoiceRoomColorLook({
  look,
  visual = "idle",
  getAmplitude,
  getResponseAmplitude,
  respondingStyle = "rings",
  eyePlacement = "center",
  wavePlacement = "center",
  wavePalette = "tone",
  waveStyle = "fill",
  entryOrigin = null,
  viewport,
}: {
  look: VoiceRoomLook;
  /** Session phase — drives which per-state treatment the look shows. */
  visual?: VoiceAvatarVisual;
  /** Mic (input) amplitude source (0–1) — the listening waveform + eye bob. */
  getAmplitude?: () => number;
  /** TTS (output) amplitude source (0–1) — the responding treatment. Falls
   *  back to {@link getAmplitude} when omitted. */
  getResponseAmplitude?: () => number;
  /** Which responding-state treatment to show (sketch knob). */
  respondingStyle?: VoiceRespondingStyle;
  eyePlacement?: VoiceEyePlacement;
  wavePlacement?: VoiceWavePlacement;
  wavePalette?: VoiceWavePalette;
  waveStyle?: VoiceWaveStyle;
  /** Viewport point the entrance grows from (the tapped control). Null → the
   *  fixed screen-center origin. */
  entryOrigin?: { x: number; y: number } | null;
  /** Override the room box (Storybook renders in a box, not the full window). */
  viewport?: { w: number; h: number };
}) {
  const reduce = useReducedMotion();
  const measured = useViewportSize();
  const { w, h } = viewport ?? measured;

  // Where the entrance grows from: the tapped control's viewport point, or the
  // fixed picker-height screen center when none was captured (or in Storybook).
  const origin = entryOrigin ?? { x: w / 2, y: (ENTER_FROM_CENTER_VH / 100) * h };

  // Per-state treatments. The waveform is the user's live voice (listening
  // only); the eyes sink low only while listening, then ride back up to center
  // the moment the turn passes to the assistant (thinking + responding), so the
  // rise doubles as the "over to you" beat. The centered eye top is where they
  // come to rest — the thinking dots hang just above it.
  const showWaves = visual === "listening";
  const sinkEyes = visual === "listening";
  const centeredEyeTop = useMemo(
    () => (h - eyeDisplayHeight(look.art, w, h)) / 2,
    [look.art, w, h],
  );

  // Body grows to cover the screen end to end, from the small avatar size at
  // the entry origin — onboarding's Introduction grow, re-anchored to where the
  // user tapped. The body's rest center is the screen center (w/2, h/2), so it
  // starts offset by (origin − center) and slides to 0.
  const bodyGeometry = useMemo(() => {
    if (!look.body) return null;
    const coverSize = 1.25 * Math.max(w, h);
    const coverH = (coverSize * look.body.viewBox.height) / look.body.viewBox.width;
    return {
      coverSize,
      coverH,
      left: (w - coverSize) / 2,
      top: (h - coverH) / 2,
      startScale: ENTER_FROM_SIZE / coverSize,
      startX: origin.x - w / 2,
      startY: origin.y - h / 2,
    };
  }, [look.body, w, h, origin.x, origin.y]);

  return (
    <>
      {/* Dark base, so the grow has something to happen over. */}
      <div
        className="absolute inset-0"
        style={{ backgroundColor: DARK_SURFACE }}
      />

      {/* The avatar color fills in behind the body so coverage is end-to-end
          even where the body shape has gaps/spikes. */}
      <motion.div
        className="absolute inset-0"
        style={{ backgroundColor: look.bgHex }}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reduce ? { duration: 0 } : { duration: 0.6, delay: 0.35 }}
      />

      {/* Body — springs from "avatar on the screen" to covering it. */}
      {look.body && bodyGeometry ? (
        <motion.svg
          aria-hidden="true"
          className="pointer-events-none absolute"
          viewBox={`0 0 ${look.body.viewBox.width} ${look.body.viewBox.height}`}
          width={bodyGeometry.coverSize}
          height={bodyGeometry.coverH}
          style={{
            left: bodyGeometry.left,
            top: bodyGeometry.top,
            transformOrigin: "center",
          }}
          initial={
            reduce
              ? false
              : {
                  scale: bodyGeometry.startScale,
                  x: bodyGeometry.startX,
                  y: bodyGeometry.startY,
                }
          }
          animate={{ scale: 1, x: 0, y: 0 }}
          transition={
            reduce
              ? { duration: 0 }
              : { type: "spring", stiffness: 78, damping: 18, mass: 1 }
          }
        >
          <path d={look.body.svgPath} fill={look.bgHex} />
        </motion.svg>
      ) : null}

      {/* Per-state treatment layer — the listening waves, the thinking dots,
          and the responding treatment cross-fade as the session moves between
          states (only one is live at a time), so nothing pops in or vanishes
          hard. The listening→thinking hand-off in particular reads as the waves
          dissolving out and the dots dissolving in while the eyes ride up. */}
      <AnimatePresence>
        {/* The user's voice, gathering behind the eyes while they speak. */}
        {showWaves && getAmplitude ? (
          <motion.div
            key="listening"
            className="pointer-events-none absolute inset-0"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.3 }}
          >
            <VoiceListeningWaves
              getAmplitude={getAmplitude}
              waveStyle={waveStyle}
              palette={wavePalette}
              placement={wavePlacement}
            />
          </motion.div>
        ) : null}

        {/* Thinking: the eyes have ridden back up to center; a quiet dot triad
            works away just above them. */}
        {visual === "thinking" ? (
          <motion.div
            key="thinking"
            className="pointer-events-none absolute inset-0"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.3 }}
          >
            <VoiceThinkingIndicator
              viewport={{ w, h }}
              eyesTop={centeredEyeTop}
            />
          </motion.div>
        ) : null}

        {/* Responding: the eyes stay centered (engaged, addressing the user)
            and the assistant's voice radiates outward from behind them, driven
            by the TTS-output amplitude — energy going out, the mirror of
            listening's incoming waves. */}
        {visual === "responding" ? (
          <motion.div
            key="responding"
            className="pointer-events-none absolute inset-0"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.3 }}
          >
            <VoiceRespondingTreatment
              style={respondingStyle}
              getAmplitude={getResponseAmplitude ?? getAmplitude}
              waveStyle={waveStyle}
              wavePlacement={wavePlacement}
              viewport={{ w, h }}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <VoiceRoomEyes
        art={look.art}
        placement={eyePlacement}
        viewport={{ w, h }}
        entranceOrigin={origin}
        getAmplitude={getAmplitude}
        // The centered eyes drop low only while the user speaks (`listening`),
        // sinking with the voice, then ride back up to center for the
        // assistant's turn (see `VoiceRoomEyes`).
        sink={sinkEyes}
        // Reconnecting: fade the eyes back — presence dimmed while away.
        dimmed={visual === "reconnecting"}
      />
    </>
  );
}

/**
 * Thinking indicator — a soft triad of dots pulsing in sequence just above the
 * centered eyes, in the room's foreground tone so it reads on any avatar color.
 * `eyesTop` is the top of the centered eyes; the triad hangs a short gap above
 * it (both scaled against the room box) so it stays clear of the eyes in any
 * frame. A first-pass "the assistant is working" motif.
 */
function VoiceThinkingIndicator({
  viewport,
  eyesTop,
}: {
  viewport: { w: number; h: number };
  /** Top edge (px) of the centered eyes — the triad hangs above this. */
  eyesTop: number;
}) {
  const reduce = useReducedMotion();
  // Size against the room box (not fixed px) so the dots keep the same
  // proportion in a small Storybook frame and the full-window app.
  const dot = Math.max(8, Math.round(0.04 * Math.min(viewport.w, viewport.h)));
  // Hang the triad's center a short gap above the eyes' top edge, clamped so it
  // never rides off the top of a short frame.
  const top = Math.max(dot * 1.5, eyesTop - dot * 2.5);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 z-[1] flex -translate-x-1/2 -translate-y-1/2 items-center"
      style={{ top, gap: dot }}
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block rounded-full"
          style={{
            width: dot,
            height: dot,
            backgroundColor: "var(--room-fg, #ffffff)",
          }}
          initial={reduce ? false : { opacity: 0.3, scale: 0.75 }}
          animate={
            reduce
              ? { opacity: 0.6 }
              : { opacity: [0.3, 1, 0.3], scale: [0.75, 1, 0.75] }
          }
          transition={
            reduce
              ? { duration: 0 }
              : {
                  duration: 1.1,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: i * 0.18,
                }
          }
        />
      ))}
    </div>
  );
}

/**
 * Candidate responding-state treatments (sketches to compare in Storybook):
 * - `rings`    — concentric rings expanding outward from behind the eyes,
 *                the mirror of listening's incoming waves (energy going out).
 * - `halo`     — a soft radial bloom around the eyes that swells with speech.
 * - `waveform` — the centered waveform again, now the assistant's own voice.
 * - `pulse`    — the whole color field brightens gently on speech peaks.
 * All ride the TTS-output amplitude and tint from the room foreground tone.
 */
export type VoiceRespondingStyle = "rings" | "halo" | "waveform" | "pulse";

/**
 * Smoothed output-amplitude → `--resp-amp` on a ref, for the responding
 * treatments to read in CSS. Imperative rAF (never React state), mirroring the
 * waveform / eye-sink loops.
 */
function useRespondingAmp(getAmplitude?: () => number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const getRef = useRef(getAmplitude);
  const reduce = useReducedMotion();
  useEffect(() => {
    getRef.current = getAmplitude;
  }, [getAmplitude]);
  useEffect(() => {
    if (reduce) return;
    const node = ref.current;
    if (!node) return;
    const smoother = createAmplitudeSmoother({ attackMs: 90, releaseMs: 260 });
    let raf = 0;
    let lastTime = performance.now();
    let lastWritten = "";
    const tick = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;
      const get = getRef.current;
      const target = get ? Math.min(1, Math.max(0, get())) : 0;
      const v = smoother.step(target, dt).toFixed(3);
      if (v !== lastWritten) {
        lastWritten = v;
        node.style.setProperty("--resp-amp", v);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);
  return ref;
}

function VoiceRespondingTreatment({
  style,
  getAmplitude,
  waveStyle,
  wavePlacement,
  viewport,
}: {
  style: VoiceRespondingStyle;
  getAmplitude?: () => number;
  waveStyle: VoiceWaveStyle;
  wavePlacement: VoiceWavePlacement;
  viewport: { w: number; h: number };
}) {
  const ampRef = useRespondingAmp(getAmplitude);
  const reduce = useReducedMotion();
  // Size against the room box (not `vh`/`vw`, which ignore the Storybook frame
  // and resolve against the window) so proportions match app and Storybook.
  const M = Math.min(viewport.w, viewport.h);

  if (style === "waveform") {
    // The assistant's own voice — reuse the centered band, output-driven.
    return getAmplitude ? (
      <VoiceListeningWaves
        getAmplitude={getAmplitude}
        waveStyle={waveStyle}
        palette="tone"
        placement={wavePlacement}
      />
    ) : null;
  }

  if (style === "pulse") {
    // The whole color field lightens gently on speech peaks.
    return (
      <div
        ref={ampRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundColor: "var(--room-fg, #ffffff)",
          opacity: "calc(var(--resp-amp, 0) * 0.14)",
        }}
      />
    );
  }

  if (style === "halo") {
    // A soft radial bloom behind the eyes, swelling + brightening with speech.
    return (
      <div
        ref={ampRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center"
      >
        <div
          style={{
            width: Math.round(0.9 * M),
            height: Math.round(0.9 * M),
            borderRadius: "9999px",
            background:
              "radial-gradient(circle, color-mix(in srgb, var(--room-fg, #ffffff) 24%, transparent) 0%, transparent 66%)",
            transform: "scale(calc(0.8 + var(--resp-amp, 0) * 0.5))",
            opacity: "calc(0.35 + var(--resp-amp, 0) * 0.65)",
            transformOrigin: "center",
          }}
        />
      </div>
    );
  }

  // `rings` — concentric rings expanding outward from the eyes; overall
  // presence scales with the TTS amplitude.
  return (
    <div
      ref={ampRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center"
      style={{ opacity: "calc(0.25 + var(--resp-amp, 0) * 0.75)" }}
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="absolute rounded-full border-2"
          style={{
            width: Math.round(0.5 * M),
            height: Math.round(0.5 * M),
            borderColor:
              "color-mix(in srgb, var(--room-fg, #ffffff) 55%, transparent)",
          }}
          initial={reduce ? false : { scale: 0.4, opacity: 0.55 }}
          animate={
            reduce ? { opacity: 0.2 } : { scale: [0.4, 1.75], opacity: [0.55, 0] }
          }
          transition={
            reduce
              ? { duration: 0 }
              : { duration: 2.4, repeat: Infinity, ease: "easeOut", delay: i * 0.8 }
          }
        />
      ))}
    </div>
  );
}

/**
 * Rest position + entrance geometry for the eyes, per placement. The eyes grow
 * from the entry origin (start offset by `origin − restCenter`, scaled down)
 * and settle at rest with a small dip. `sinkTravel` is how far the centered
 * eyes can slide toward the bottom rest while the user speaks (0 for the
 * bottom placement — nowhere lower).
 */
function eyeLayout(
  placement: VoiceEyePlacement,
  eyesW: number,
  eyesH: number,
  w: number,
  h: number,
  origin: { x: number; y: number },
): {
  restTop: number;
  startX: number;
  startY: number;
  dipY: number;
  sinkTravel: number;
} {
  const bottomRestTop = h - (1 - EYE_REST_CUTOFF) * eyesH;
  const restTop = placement === "center" ? (h - eyesH) / 2 : bottomRestTop;
  // Rest center (the eyes are horizontally centered: left = (w − eyesW) / 2).
  const restCenterX = w / 2;
  const restCenterY = restTop + eyesH / 2;
  return {
    restTop,
    startX: origin.x - restCenterX,
    startY: origin.y - restCenterY,
    // A small settle dip below rest as they land.
    dipY: eyesH * 0.12,
    sinkTravel:
      placement === "center" ? Math.max(0, bottomRestTop - restTop) : 0,
  };
}

export function VoiceRoomEyes({
  art,
  viewport,
  placement = "center",
  entranceOrigin,
  getAmplitude,
  sink = false,
  dimmed = false,
}: {
  art: VoiceRoomEyeArt;
  /** The room box the eyes are framed in (the caller's live viewport size). */
  viewport: { w: number; h: number };
  placement?: VoiceEyePlacement;
  /** Viewport point the eyes grow from on entrance. Defaults to screen center. */
  entranceOrigin?: { x: number; y: number };
  /** Mic amplitude source (0–1); drives the live bob while the eyes are sunk. */
  getAmplitude?: () => number;
  /** Hold the eyes at the low rest (while the user speaks — `listening`). */
  sink?: boolean;
  /** Fade the eyes back (the reconnecting state — presence dimmed while away). */
  dimmed?: boolean;
}) {
  const reduce = useReducedMotion();
  const { w, h } = viewport;
  const playEntrance = !reduce;

  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (reduce) return;
    const onMove = (e: MouseEvent) => {
      setPointer({
        x: (e.clientX / window.innerWidth - 0.5) * 2,
        y: (e.clientY / window.innerHeight - 0.5) * 2,
      });
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [reduce]);

  // Two settle blinks once the entrance lands, then a slow random idle blink —
  // onboarding's entrance blink choreography.
  const [blinking, setBlinking] = useState(false);
  const [entranceDone, setEntranceDone] = useState(!playEntrance);
  useEffect(() => {
    if (reduce || !entranceDone) return;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout>;
    const blink = (next: () => void) => {
      if (cancelled) return;
      setBlinking(true);
      t = setTimeout(() => {
        if (cancelled) return;
        setBlinking(false);
        t = setTimeout(next, 140);
      }, 140);
    };
    const idle = () => {
      t = setTimeout(() => blink(idle), 2500 + Math.random() * 4000);
    };
    blink(() => blink(idle));
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [reduce, entranceDone]);

  const originX = entranceOrigin?.x ?? w / 2;
  const originY = entranceOrigin?.y ?? (ENTER_FROM_CENTER_VH / 100) * h;
  const geometry = useMemo(() => {
    const eyesH = eyeDisplayHeight(art, w, h);
    const eyesW = (eyesH * art.bbox.w) / art.bbox.h;
    const { restTop, startX, startY, dipY, sinkTravel } = eyeLayout(
      placement,
      eyesW,
      eyesH,
      w,
      h,
      { x: originX, y: originY },
    );
    return {
      eyesW,
      eyesH,
      left: (w - eyesW) / 2,
      restTop,
      startX,
      startY,
      dipY,
      sinkTravel,
    };
  }, [art, w, h, placement, originX, originY]);

  // Sink: while the user speaks (`listening`) the centered eyes drop to a low
  // hold near the bottom rest (`EYE_LISTEN_SINK_BASE` of the travel) so they
  // sit clear of the centered waveform; when the turn passes to the assistant
  // they sweep back up to center. Two nested wrappers so the parts compose:
  // - The big center↔low-hold travel is a motion tween on the hold wrapper
  //   below — the same animation system as the entrance keyframes (per-frame
  //   imperative writes of the full travel fought the entrance's transforms
  //   and read as stutter). `sink` retargets the tween; a mid-flight reversal
  //   continues from wherever the eyes are.
  // - The residual mic bob (≤15% of the travel) stays an imperative smoothed
  //   rAF writing `translateY` on the inner wrapper — a live noisy signal has
  //   no place in React state or tween retargets. It releases to 0 the moment
  //   the sink lifts, so the rise is the motion tween alone.
  const sinkRef = useRef<HTMLDivElement | null>(null);
  const getAmplitudeRef = useRef(getAmplitude);
  const sinkActiveRef = useRef(sink);
  const sinkTravelRef = useRef(geometry.sinkTravel);
  useEffect(() => {
    getAmplitudeRef.current = getAmplitude;
  }, [getAmplitude]);
  useEffect(() => {
    sinkActiveRef.current = sink;
  }, [sink]);
  useEffect(() => {
    sinkTravelRef.current = geometry.sinkTravel;
  }, [geometry.sinkTravel]);
  useEffect(() => {
    if (reduce) return;
    const node = sinkRef.current;
    if (!node) return;
    const bobSmoother = createAmplitudeSmoother({ attackMs: 160, releaseMs: 380 });
    let raf = 0;
    let lastTime = performance.now();
    let lastWritten = "";
    const tick = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;
      const get = getAmplitudeRef.current;
      const amp = get ? Math.min(1, Math.max(0, get())) : 0;
      const bob = bobSmoother.step(sinkActiveRef.current ? amp : 0, dt);
      const shift = (bob * (1 - EYE_LISTEN_SINK_BASE) * sinkTravelRef.current).toFixed(1);
      if (shift !== lastWritten) {
        lastWritten = shift;
        node.style.transform = `translateY(${shift}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  // The low-hold offset the hold wrapper tweens to while sunk (0 for the
  // bottom placement — nowhere lower to go).
  const holdY = geometry.sinkTravel * EYE_LISTEN_SINK_BASE;

  const cx = art.bbox.x + art.bbox.w / 2;
  const cy = art.bbox.y + art.bbox.h / 2;

  return (
    <motion.div
      aria-hidden="true"
      data-testid="voice-room-eyes"
      className="pointer-events-none absolute"
      style={{
        left: geometry.left,
        top: geometry.restTop,
        width: geometry.eyesW,
        height: geometry.eyesH,
        transformOrigin: "center",
      }}
      initial={
        playEntrance
          ? { x: geometry.startX, y: geometry.startY, scale: 0.35 }
          : false
      }
      // Play the grow-in keyframes only until the entrance lands, then hold a
      // stable static target. Otherwise every re-render (a `visual`/`sink`
      // change) hands Motion a fresh keyframe array and it replays part of the
      // entrance — the eyes lurch toward the origin and snap back, fighting the
      // smooth sink-rise on the listening→thinking hand-off.
      animate={
        playEntrance && !entranceDone
          ? {
              x: [geometry.startX, 0, 0],
              y: [geometry.startY, geometry.dipY, 0],
              scale: [0.35, 1, 1],
            }
          : { x: 0, y: 0, scale: 1 }
      }
      transition={
        playEntrance && !entranceDone
          ? { duration: 1, times: [0, 0.7, 1], ease: "easeInOut" }
          : { duration: 0 }
      }
      onAnimationComplete={() => setEntranceDone(true)}
    >
      {/* Turn hold: the big center↔low-hold travel, on the same motion tween
          system as the entrance. `sink` retargets `y`; a mid-flight reversal
          continues smoothly from wherever the eyes are. */}
      <motion.div
        animate={reduce ? { y: 0 } : { y: sink ? holdY : 0 }}
        transition={
          reduce
            ? { duration: 0 }
            : {
                duration: (sink ? EYE_SINK_MS : EYE_RISE_MS) / 1000,
                ease: "easeInOut",
              }
        }
      >
        {/* Speak-to-sink bob: rAF writes translateY here as the voice rises.
            The opacity fades the eyes back while reconnecting (rAF only
            touches `transform`, so it never clobbers this). */}
        <div
          ref={sinkRef}
          style={{
            opacity: dimmed ? 0.4 : 1,
            transition: "opacity 0.5s ease",
          }}
        >
          {/* Slight parallax: the whole eyes drift smoothly toward the cursor. */}
          <div
            style={{
              transform: `translate(${pointer.x * CURSOR_MAX_X}px, ${pointer.y * CURSOR_MAX_Y}px)`,
              transition: "transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
            <svg
              viewBox={`${art.bbox.x} ${art.bbox.y} ${art.bbox.w} ${art.bbox.h}`}
              width={geometry.eyesW}
              height={geometry.eyesH}
              style={{ overflow: "visible", display: "block" }}
            >
              <g
                style={{
                  transform: blinking ? "scaleY(0.1)" : "scaleY(1)",
                  transformOrigin: `${cx}px ${cy}px`,
                  transition: "transform 0.14s ease-in-out",
                }}
              >
                {art.paths.map((p, i) => (
                  <path key={i} d={p.svgPath} fill={p.color} />
                ))}
              </g>
            </svg>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
