import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";

import { CastAvatar } from "@/cast/cast-avatar";
import { CastProp, type PropKey } from "@/cast/cast-prop-art";
import { REACTIONS } from "@/cast/cast-reactions";
import type { Edge, Placement, RatherChoice } from "@/cast/cast-content";
import { CAST, type CastCharacter, type Reaction } from "@/cast/cast-roster";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

// The dudes' own "burst" body, reused as the Super-Saiyan aura starburst.
const AURA_BURST =
  BUNDLED_COMPONENTS.bodyShapes.find((b) => b.id === "burst") ??
  BUNDLED_COMPONENTS.bodyShapes[0];

export interface Rect {
  left: number;
  top: number;
  size: number;
}

export interface MimeState {
  rather: RatherChoice;
  edge: Edge;
  nonce: number; // bump to replay
}

/** A held job prop and the fixed slot it occupies around the character. */
export interface HeldProp {
  key: PropKey;
  slot: number; // stable index (JOBS order) so props don't reshuffle on removal
  fly: Edge | null; // fly in from this edge on first mount; null = already there
}

/** Stable slots ringing the character — one per job, so multiple props cluster
 * around the dude without overlapping. */
const HELD_SLOTS: React.CSSProperties[] = [
  { left: "48%", top: "54%", width: "46%" }, // lower-right
  { left: "6%", top: "54%", width: "46%" }, // lower-left
  { left: "64%", top: "26%", width: "42%" }, // right
  { left: "-6%", top: "26%", width: "42%" }, // left
  { left: "27%", top: "68%", width: "46%" }, // bottom
  { left: "60%", top: "-8%", width: "40%" }, // upper-right
  { left: "0%", top: "-8%", width: "40%" }, // upper-left
  { left: "30%", top: "-24%", width: "40%" }, // top
];

/** Off-screen start distance for a flown prop, scaled to the viewport. */
function flyDistance(): number {
  if (typeof window === "undefined") return 900;
  return Math.hypot(window.innerWidth, window.innerHeight) * 0.55;
}

/** Mime placement → CSS box (percent of the hero box) + stacking. */
function placement(place: Placement): { style: React.CSSProperties; z: number } {
  switch (place) {
    case "face":
      return { style: { left: "19%", top: "21%", width: "62%" }, z: 5 };
    case "top":
      return { style: { left: "22%", top: "-24%", width: "56%" }, z: 5 };
    case "front":
      return { style: { left: "22%", top: "48%", width: "56%" }, z: 5 };
    case "back":
      // a blob can't show a pack literally "on its back", so it sits beside it
      return { style: { left: "-14%", top: "34%", width: "56%" }, z: 4 };
    default:
      return { style: {}, z: 5 };
  }
}

/**
 * A prop that either arcs in from an off-screen edge and lands (with a small
 * squash bounce), or — when `from` is null — simply rests at its placement.
 * The arc comes from x and y easing on different curves.
 */
function PropFly({
  name,
  style,
  z,
  from,
}: {
  name: PropKey;
  style: React.CSSProperties;
  z: number;
  from: Edge | null;
}) {
  const dist = flyDistance();
  const start = from ? { x: from.dx * dist, y: from.dy * dist, rot: from.rot } : null;

  return (
    <motion.div
      className="cast-prop"
      style={{ ...style, zIndex: z }}
      initial={
        start
          ? { x: start.x, y: start.y, rotate: start.rot, scaleX: 0.7, scaleY: 0.7, opacity: 0 }
          : { opacity: 1 }
      }
      animate={
        start
          ? {
              x: 0,
              y: 0,
              rotate: [start.rot, start.rot * 0.3, 0],
              scaleX: [0.7, 1, 1.14, 0.97, 1],
              scaleY: [0.7, 1, 0.86, 1.03, 1],
              opacity: 1,
            }
          : { opacity: 1 }
      }
      exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.2 } }}
      transition={
        start
          ? {
              x: { duration: 0.72, ease: [0.16, 0.82, 0.3, 1] },
              y: { duration: 0.72, ease: [0.5, 0, 0.75, 1] },
              rotate: { duration: 0.72, ease: "easeOut" },
              scaleX: { duration: 0.8, times: [0, 0.6, 0.78, 0.9, 1], ease: "easeOut" },
              scaleY: { duration: 0.8, times: [0, 0.6, 0.78, 0.9, 1], ease: "easeOut" },
              opacity: { duration: 0.16 },
            }
          : { duration: 0.2 }
      }
    >
      <CastProp name={name} className="cast-prop__art" />
    </motion.div>
  );
}

/** Traveling: a prop that sweeps across, passing the character, then leaves. */
function PropAcross({ name }: { name: PropKey }) {
  const dist = flyDistance();
  return (
    <motion.div
      className="cast-prop"
      style={{ left: "20%", top: "20%", width: "60%", zIndex: 5 }}
      initial={{ x: -dist, y: 30, rotate: 8, opacity: 0 }}
      animate={{ x: [-dist, 0, dist], y: [30, -10, 30], rotate: 8, opacity: [0, 1, 1, 0] }}
      exit={{ opacity: 0 }}
      transition={{ duration: 1.4, ease: "easeInOut", times: [0, 0.5, 1] }}
    >
      <CastProp name={name} className="cast-prop__art" />
    </motion.div>
  );
}

/** Super-Saiyan aura: spinning gold starbursts (the dudes' own burst shape),
 * a pulsing glow, and rising sparks. Easter egg when everything is selected. */
function CastAura() {
  const vb = `0 0 ${AURA_BURST.viewBox.width} ${AURA_BURST.viewBox.height}`;
  return (
    <div className="cast-aura" aria-hidden>
      <div className="cast-aura__glow" />
      <svg className="cast-aura__burst" viewBox={vb}>
        <path d={AURA_BURST.svgPath} fill="#FFD23A" />
      </svg>
      <svg className="cast-aura__burst cast-aura__burst--2" viewBox={vb}>
        <path d={AURA_BURST.svgPath} fill="#FFB020" />
      </svg>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={`cast-aura__spark s${i}`} />
      ))}
    </div>
  );
}

/** Little companion dudes that slide in beside (with friends). */
function Buddies({ seed }: { seed: number }) {
  const left = CAST[(seed * 7 + 3) % CAST.length];
  const right = CAST[(seed * 13 + 9) % CAST.length];
  return (
    <>
      <motion.div
        className="cast-buddy"
        style={{ left: "-46%", top: "34%", width: "44%", zIndex: 1 }}
        initial={{ x: -260, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: -160, opacity: 0 }}
        transition={{ type: "spring", stiffness: 220, damping: 18 }}
      >
        <CastAvatar character={left} />
      </motion.div>
      <motion.div
        className="cast-buddy"
        style={{ right: "-46%", top: "30%", width: "48%", zIndex: 1 }}
        initial={{ x: 260, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 160, opacity: 0 }}
        transition={{ type: "spring", stiffness: 220, damping: 18, delay: 0.08 }}
      >
        <CastAvatar character={right} />
      </motion.div>
    </>
  );
}

/**
 * The persistent character across Beats 2–4. Shares `layoutId="cast-hero"` so
 * it smoothly repositions/resizes between beats. Constant drift keeps it
 * alive; an imperative reaction plays on click, on the autonomous loop
 * (Beat 2), and when a mime calls for a body reaction (sleeping → yawn).
 */
export function HeroCharacter({
  character,
  box,
  interactive = false,
  autoReact = false,
  heldProps = [],
  mime = null,
  ascended = false,
}: {
  character: CastCharacter;
  box: Rect;
  interactive?: boolean;
  autoReact?: boolean;
  heldProps?: HeldProp[];
  mime?: MimeState | null;
  ascended?: boolean;
}) {
  const controls = useAnimationControls();
  // Zzz floats whenever a yawn plays — the grumpy-eyed character in Beat 2 and
  // the sleeping mime in Beat 4 both route through here.
  const [yawnNonce, setYawnNonce] = useState(0);

  const play = useCallback(
    (which?: Reaction) => {
      const name = which ?? character.reaction;
      if (name === "yawn") setYawnNonce((n) => n + 1);
      const r = REACTIONS[name];
      return controls.start(r.intro.animate, r.intro.transition);
    },
    [controls, character.reaction],
  );

  // Beat 2 autonomous loop: react → rest → repeat.
  useEffect(() => {
    if (!autoReact) return;
    let alive = true;
    void (async () => {
      await new Promise((r) => setTimeout(r, 320));
      while (alive) {
        await play();
        if (!alive) break;
        await new Promise((r) => setTimeout(r, 2200));
      }
    })();
    return () => {
      alive = false;
    };
  }, [autoReact, play]);

  // A mime that calls for a body reaction (sleeping → yawn) plays it.
  const mimeReaction = mime?.rather.mime.reaction;
  const mimeNonce = mime?.nonce;
  useEffect(() => {
    if (mimeReaction) void play(mimeReaction);
  }, [mimeNonce, mimeReaction, play]);

  // Power up on ascension: a dramatic spin.
  useEffect(() => {
    if (ascended) void play("spin");
  }, [ascended, play]);

  const m = mime?.rather.mime;
  const hideHeld = m?.replaceJob;
  // Super-Saiyan recolor: the dude turns gold.
  const shown = ascended ? { ...character, color: "yellow" } : character;

  return (
    <motion.div
      className={`cast-hero${ascended ? " is-ascended" : ""}`}
      layoutId="cast-hero"
      style={{ left: box.left, top: box.top, width: box.size, height: box.size }}
    >
      <AnimatePresence>
        {ascended && (
          <motion.div
            key="flash"
            className="cast-flash"
            initial={{ opacity: 0.95, scale: 0.2 }}
            animate={{ opacity: 0, scale: 2.4 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          />
        )}
        {ascended && <CastAura key="aura" />}
      </AnimatePresence>
      {/* back-layer mime props (backpack) sit behind the body */}
      <AnimatePresence>
        {m && m.prop && m.place === "back" && (
          <PropFly
            key={`mime-${mimeNonce}`}
            name={m.prop}
            style={placement("back").style}
            z={placement("back").z}
            from={mime!.edge}
          />
        )}
      </AnimatePresence>

      {/* the character itself: drift → hover signature → reaction → avatar */}
      <div
        className="cast-hero__body"
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={interactive ? `Make ${character.name} react` : undefined}
        onClick={interactive ? () => void play() : undefined}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void play();
                }
              }
            : undefined
        }
      >
        <div className="cast-focus-alive">
          <div className="cast-hover" data-anim={character.hover}>
            <motion.div style={{ width: "100%", height: "100%" }} animate={controls}>
              <CastAvatar character={shown} />
            </motion.div>
          </div>
        </div>
      </div>

      {/* held job props clustered in stable slots; hidden while a replacing
          mime (reading) plays */}
      <AnimatePresence>
        {!hideHeld &&
          heldProps.map((hp) => (
            <PropFly
              key={`held-${hp.key}`}
              name={hp.key}
              style={HELD_SLOTS[hp.slot % HELD_SLOTS.length]}
              z={3}
              from={hp.fly}
            />
          ))}
      </AnimatePresence>

      {/* front-layer mimes */}
      <AnimatePresence>
        {m && m.prop && m.place !== "back" && m.place !== "across" && (
          <PropFly
            key={`mime-${mimeNonce}`}
            name={m.prop}
            style={placement(m.place).style}
            z={placement(m.place).z}
            from={mime!.edge}
          />
        )}
        {m && m.prop && m.place === "across" && (
          <PropAcross key={`mime-${mimeNonce}`} name={m.prop} />
        )}
        {m?.buddies && <Buddies key={`buddies-${mimeNonce}`} seed={mimeNonce ?? 0} />}
      </AnimatePresence>

      {/* Zzz on any yawn (grumpy Beat 2 idle, sleeping Beat 4 mime) */}
      <AnimatePresence>
        {yawnNonce > 0 && (
          <motion.div
            key={`zzz-${yawnNonce}`}
            className="cast-zzz cast-zzz--hero"
            initial={{ opacity: 0, y: -4, scale: 0.6 }}
            animate={{ opacity: [0, 1, 1, 0], y: -46, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.5, ease: "easeOut" }}
          >
            z z Z
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
