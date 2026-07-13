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
 * Per-state treatments (driven by `visual`): while the user speaks
 * (`listening`) the mic-amplitude waveform swells behind the eyes — centered
 * by default so it reads as the voice gathering around them rather than rising
 * from the floor — and the eyes drop to a low hold. They stay held low through
 * the `thinking` that follows (a quiet dot indicator works above them), then
 * ride back up to center to speak (`responding`, where the assistant's voice
 * radiates outward from behind the eyes — see {@link VoiceRespondingStyle}).
 * `reconnecting` fades the eyes back — presence dimmed while away.
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
import { motion, useReducedMotion } from "motion/react";

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

/** How much of the bottom-placed eyes sits below the edge — rest, and the dip. */
const EYE_REST_CUTOFF = 0.25;
const EYE_DIP_CUTOFF = 0.46;
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
  /** Override the room box (Storybook renders in a box, not the full window). */
  viewport?: { w: number; h: number };
}) {
  const reduce = useReducedMotion();
  const measured = useViewportSize();
  const { w, h } = viewport ?? measured;

  // Per-state treatments. The waveform is the user's live voice (listening
  // only); the eyes hold low through the whole user-owned turn — listening AND
  // the thinking that follows — so they don't bob back up to center the moment
  // the user stops talking, then settle back to center for the rest.
  const showWaves = visual === "listening";
  const sinkEyes = visual === "listening" || visual === "thinking";

  // Body grows to cover the screen end to end, from the small avatar size —
  // onboarding's Introduction grow, verbatim.
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
      startY: (ENTER_FROM_CENTER_VH / 100 - 0.5) * h,
    };
  }, [look.body, w, h]);

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
              : { scale: bodyGeometry.startScale, y: bodyGeometry.startY }
          }
          animate={{ scale: 1, y: 0 }}
          transition={
            reduce
              ? { duration: 0 }
              : { type: "spring", stiffness: 78, damping: 18, mass: 1 }
          }
        >
          <path d={look.body.svgPath} fill={look.bgHex} />
        </motion.svg>
      ) : null}

      {/* The user's voice, gathering behind the eyes while they speak. */}
      {showWaves && getAmplitude ? (
        <VoiceListeningWaves
          getAmplitude={getAmplitude}
          waveStyle={waveStyle}
          palette={wavePalette}
          placement={wavePlacement}
        />
      ) : null}

      {/* Thinking: the eyes stay held low (looking down, pondering) while a
          quiet indicator works away above them. */}
      {visual === "thinking" ? <VoiceThinkingIndicator /> : null}

      {/* Responding: the eyes ride back up to center (engaged, addressing the
          user) and the assistant's voice radiates outward from behind them,
          driven by the TTS-output amplitude — energy going out, the mirror of
          listening's incoming waves. */}
      {visual === "responding" ? (
        <VoiceRespondingTreatment
          style={respondingStyle}
          getAmplitude={getResponseAmplitude ?? getAmplitude}
          waveStyle={waveStyle}
          wavePlacement={wavePlacement}
        />
      ) : null}

      <VoiceRoomEyes
        art={look.art}
        placement={eyePlacement}
        viewport={{ w, h }}
        getAmplitude={getAmplitude}
        // The centered eyes hold low through the user-owned turn (listening +
        // thinking), sinking with the voice while listening (see `VoiceRoomEyes`).
        sink={sinkEyes}
        // Reconnecting: fade the eyes back — presence dimmed while away.
        dimmed={visual === "reconnecting"}
      />
    </>
  );
}

/**
 * Thinking indicator — a soft triad of dots pulsing in sequence above the
 * held-low eyes, in the room's foreground tone so it reads on any avatar
 * color. A first-pass "the assistant is working" motif; the responding-state
 * treatment (and whether thinking wants something richer) is still open.
 */
function VoiceThinkingIndicator() {
  const reduce = useReducedMotion();
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 z-[1] flex -translate-x-1/2 items-center gap-3"
      style={{ top: "34%" }}
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block size-3 rounded-full"
          style={{ backgroundColor: "var(--room-fg, #ffffff)" }}
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
}: {
  style: VoiceRespondingStyle;
  getAmplitude?: () => number;
  waveStyle: VoiceWaveStyle;
  wavePlacement: VoiceWavePlacement;
}) {
  const ampRef = useRespondingAmp(getAmplitude);
  const reduce = useReducedMotion();

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
            width: "min(70vh, 70vw)",
            aspectRatio: "1 / 1",
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
            width: "min(38vh, 38vw)",
            height: "min(38vh, 38vw)",
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
 * Rest position + entrance travel for the eyes, per placement, plus
 * `sinkTravel`: how far the centered eyes can slide down toward the bottom
 * rest while the user speaks (0 for the bottom placement — nowhere lower).
 */
function eyeLayout(
  placement: VoiceEyePlacement,
  eyesH: number,
  h: number,
): { restTop: number; startY: number; dipY: number; sinkTravel: number } {
  const bottomRestTop = h - (1 - EYE_REST_CUTOFF) * eyesH;
  if (placement === "center") {
    const restTop = (h - eyesH) / 2;
    return {
      restTop,
      // Grow in place with a small settle dip — no long travel from the floor.
      startY: -eyesH * 0.22,
      dipY: eyesH * 0.12,
      // Full voice pulls the eyes all the way down to the bottom rest.
      sinkTravel: Math.max(0, bottomRestTop - restTop),
    };
  }
  return {
    restTop: bottomRestTop,
    // Rise from the picker's centered position (40vh), dipping below rest.
    startY: (ENTER_FROM_CENTER_VH / 100) * h - (bottomRestTop + eyesH / 2),
    dipY: (EYE_DIP_CUTOFF - EYE_REST_CUTOFF) * eyesH,
    sinkTravel: 0,
  };
}

export function VoiceRoomEyes({
  art,
  viewport,
  placement = "center",
  getAmplitude,
  sink = false,
  dimmed = false,
}: {
  art: VoiceRoomEyeArt;
  /** The room box the eyes are framed in (the caller's live viewport size). */
  viewport: { w: number; h: number };
  placement?: VoiceEyePlacement;
  /** Mic amplitude source (0–1); drives the live bob while the eyes are sunk. */
  getAmplitude?: () => number;
  /** Hold the eyes at the low rest (the user-owned turn — listening + thinking). */
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

  const geometry = useMemo(() => {
    const maxEyesW = w * EYE_MAX_WIDTH;
    const eyesH = Math.min(
      Math.min(w, h) * EYE_TARGET_HEIGHT,
      (maxEyesW * art.bbox.h) / art.bbox.w,
    );
    const eyesW = (eyesH * art.bbox.w) / art.bbox.h;
    const { restTop, startY, dipY, sinkTravel } = eyeLayout(placement, eyesH, h);
    return {
      eyesW,
      eyesH,
      left: (w - eyesW) / 2,
      restTop,
      startY,
      dipY,
      sinkTravel,
    };
  }, [art, w, h, placement]);

  // Sink: while the user owns the turn (listening + thinking) the centered eyes
  // drop to a low hold near the bottom rest (`EYE_LISTEN_SINK_BASE` of the
  // travel) so they sit clear of the centered waveform, then bob the remaining
  // fraction with the mic amplitude — they don't float back up to center
  // between words or when the user stops. Driven imperatively (never React
  // state, matching the waveform / avatar) through a smoothed rAF loop writing
  // `translateY` on a dedicated wrapper — kept off the entrance `y` and the
  // cursor parallax so all three compose.
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
    // Drop to the low hold when listening starts, ease back up to center when
    // it ends — a touch slower than the waveform so the eyes settle, not
    // jitter.
    const smoother = createAmplitudeSmoother({ attackMs: 160, releaseMs: 380 });
    let raf = 0;
    let lastTime = performance.now();
    let lastWritten = "";
    const tick = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;
      const get = getAmplitudeRef.current;
      // While sunk the eyes hold at `EYE_LISTEN_SINK_BASE` of the travel and
      // bob the rest with amplitude; otherwise they return to center (0).
      const amp = get ? Math.min(1, Math.max(0, get())) : 0;
      const target = sinkActiveRef.current
        ? EYE_LISTEN_SINK_BASE + (1 - EYE_LISTEN_SINK_BASE) * amp
        : 0;
      const shift = (smoother.step(target, dt) * sinkTravelRef.current).toFixed(1);
      if (shift !== lastWritten) {
        lastWritten = shift;
        node.style.transform = `translateY(${shift}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

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
      initial={playEntrance ? { y: geometry.startY, scale: 0.35 } : false}
      animate={
        playEntrance
          ? { y: [geometry.startY, geometry.dipY, 0], scale: [0.35, 1, 1] }
          : { y: 0, scale: 1 }
      }
      transition={
        playEntrance
          ? { duration: 1, times: [0, 0.7, 1], ease: "easeInOut" }
          : { duration: 0 }
      }
      onAnimationComplete={() => setEntranceDone(true)}
    >
      {/* Speak-to-sink: rAF writes translateY here as the voice rises. The
          opacity fades the eyes back while reconnecting (rAF only touches
          `transform`, so it never clobbers this). */}
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
  );
}
