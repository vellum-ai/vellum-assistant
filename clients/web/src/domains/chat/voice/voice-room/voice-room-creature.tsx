/**
 * SPIKE — the "creature" voice-room look: a *raster* counterpart to
 * {@link VoiceRoomColorLook} for a vellumized user image.
 *
 * The character look grows an SVG *body path* to fill the screen; a real photo
 * has no path, so this look grows the segmented *sprite* instead — the one
 * engine fork the parity work forces (vector morph → raster sprite). Everything
 * else is reused wholesale from the character system, which is the point of the
 * spike: a processed image lights up the same surfaces a built avatar does.
 *
 *   1. dark base → the amber fill fades in → the sprite springs from the entry
 *      origin up to fill the room (mirrors the body grow),
 *   2. the sprite breathes (a perpetual sub-2% scale pulse) so Pax reads alive,
 *   3. the grafted eyes grow in under the hat brim (`faceCenter`), then blink /
 *      parallax / resize per state — the {@link VoiceRoomEyes} the character
 *      look uses, verbatim,
 *   4. listening waves, responding rings, and the state caption are the shared
 *      chrome, unchanged.
 *
 * The morph is the one thing lost: a per-vertex path wobble can't run on a
 * raster. Breathing stands in as the sprite-safe "alive" cue.
 *
 * Decorative: `aria-hidden`, `pointer-events-none`, reduced-motion safe (no
 * entrance, no breathing, no parallax; the discrete blink is kept).
 */

import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

import { VoiceListeningWaves } from "./voice-listening-waves";
import type { VoiceAvatarVisual } from "./voice-avatar-state";
import type { VellumizedCreature } from "./pax-creature-asset";
import {
  EYE_STATE_SCALE,
  VoiceRespondingRings,
  VoiceRoomEyes,
  VoiceStateCaption,
  eyeDisplayHeight,
} from "./voice-room-eyes";

/** How tall the sprite is grown, as a fraction of the room height (portrait
 *  sprite → vertical fill, amber showing at the sides). */
const SPRITE_COVER_H = 1.06;
/** The grafted eyes sit smaller on a detailed sprite than the character look's
 *  screen-filling eyes — a base factor under the per-state scale so they read as
 *  eyes *on a face*, not the whole face. */
const CREATURE_EYE_SCALE = 0.72;
/** Entrance start size of the sprite (the "avatar on the screen" size it grows
 *  from), mirroring the character look's `ENTER_FROM_SIZE`. */
const ENTER_FROM_SIZE = 220;
const DARK_SURFACE = "#17191C";

function windowSize(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}

function useViewportSize(): { w: number; h: number } {
  const [size, setSize] = useState(windowSize);
  useEffect(() => {
    const onResize = () => setSize(windowSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

export function VoiceRoomCreatureLook({
  creature,
  visual = "idle",
  getAmplitude,
  getResponseAmplitude,
  showStateCaption = true,
  entryOrigin = null,
  viewport,
}: {
  creature: VellumizedCreature;
  visual?: VoiceAvatarVisual;
  /** Mic (input) amplitude source (0–1) — the listening waveform. */
  getAmplitude?: () => number;
  /** TTS (output) amplitude source (0–1) — the responding rings. */
  getResponseAmplitude?: () => number;
  showStateCaption?: boolean;
  /** Viewport point the entrance grows from (the tapped control). */
  entryOrigin?: { x: number; y: number } | null;
  /** Override the room box (Storybook renders in a box, not the full window). */
  viewport?: { w: number; h: number };
}) {
  const reduce = useReducedMotion();
  const measured = useViewportSize();
  const { w, h } = viewport ?? measured;

  const origin = entryOrigin ?? { x: w / 2, y: 0.4 * h };
  const showWaves = visual === "listening";
  const sizeScale = EYE_STATE_SCALE[visual] * CREATURE_EYE_SCALE;

  // Cover geometry: the portrait sprite fills the room vertically, centered, so
  // the amber shows at the sides. Springs from the entry origin, like the body.
  const sprite = useMemo(() => {
    const coverH = SPRITE_COVER_H * h;
    const coverW = coverH / creature.spriteAspect;
    const left = (w - coverW) / 2;
    const top = (h - coverH) / 2;
    return {
      coverH,
      coverW,
      left,
      top,
      startScale: ENTER_FROM_SIZE / coverH,
      startX: origin.x - w / 2,
      startY: origin.y - h / 2,
      // The eyes pin to the hat-brim face-center on the grown sprite.
      faceY: top + creature.faceCenter.y * coverH,
    };
  }, [creature.spriteAspect, creature.faceCenter.y, w, h, origin.x, origin.y]);

  const eyeH = eyeDisplayHeight(creature.eyeArt, w, h) * CREATURE_EYE_SCALE;
  const captionTop = sprite.faceY + eyeH / 2 + Math.max(24, eyeH * 0.3);

  return (
    <>
      {/* Dark base, so the grow has something to happen over. */}
      <div className="absolute inset-0" style={{ backgroundColor: DARK_SURFACE }} />

      {/* The dominant color fills the room behind the sprite. */}
      <motion.div
        className="absolute inset-0"
        style={{ backgroundColor: creature.fillHex }}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reduce ? { duration: 0 } : { duration: 0.6, delay: 0.35 }}
      />

      {/* The sprite — springs from "on the screen" to filling it, then breathes.
          Two nested layers: the outer plays the one-shot grow, the inner runs the
          perpetual breathing loop, so the two never fight. */}
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute"
        style={{
          left: sprite.left,
          top: sprite.top,
          width: sprite.coverW,
          height: sprite.coverH,
          transformOrigin: "center",
        }}
        initial={
          reduce
            ? false
            : { scale: sprite.startScale, x: sprite.startX, y: sprite.startY }
        }
        animate={{ scale: 1, x: 0, y: 0 }}
        transition={
          reduce ? { duration: 0 } : { type: "spring", stiffness: 78, damping: 18, mass: 1 }
        }
      >
        <motion.img
          src={creature.spriteUrl}
          alt=""
          className="size-full object-contain"
          style={{ transformOrigin: "center bottom" }}
          animate={reduce ? undefined : { scale: [1, 1.018, 1] }}
          transition={
            reduce
              ? undefined
              : { duration: 4, repeat: Infinity, ease: "easeInOut" }
          }
          draggable={false}
        />
      </motion.div>

      {/* Listening waves sweep in from the top edge while the user speaks — the
          shared chrome, toned to the room foreground so they read on the amber. */}
      {showWaves && getAmplitude ? (
        <div className="pointer-events-none absolute inset-0">
          <VoiceListeningWaves getAmplitude={getAmplitude} palette="tone" placement="top" />
        </div>
      ) : null}

      {/* Responding: the assistant's voice radiates outward from the sprite. */}
      {visual === "responding" ? (
        <div className="pointer-events-none absolute inset-0">
          <VoiceRespondingRings
            getAmplitude={getResponseAmplitude ?? getAmplitude}
            viewport={{ w, h }}
          />
        </div>
      ) : null}

      {/* The grafted eyes, pinned under the hat brim — the character system's
          eyes, borrowed by a photo. Blink / parallax / per-state resize, free. */}
      <VoiceRoomEyes
        art={creature.eyeArt}
        viewport={{ w, h }}
        entranceOrigin={origin}
        restCenterY={sprite.faceY}
        sizeScale={sizeScale}
        dimmed={visual === "reconnecting"}
      />

      {showStateCaption ? (
        <VoiceStateCaption visual={visual} top={captionTop} />
      ) : null}
    </>
  );
}
