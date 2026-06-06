import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { HeroCharacter, type HeldProp, type Rect } from "@/cast/cast-hero";
import { kickoffStyleContext, type StyleProfile } from "@/cast/cast-hooks";
import { JOBS, type JobKey } from "@/cast/cast-content";
import type { CastCharacter, Reaction } from "@/cast/cast-roster";

type Side = "left" | "right";

/**
 * Each chosen value gets a reaction that *means* the choice, so the character
 * reads as reacting to the answer (not just the tap).
 */
const VALUE_REACTION: Record<string, Reaction> = {
  send_it: "startle", // leaps into action
  show_me: "peer", // considers, checks first
  point: "huff", // quick, to the point
  walk: "sway", // calm, walks you through
  one: "tilt", // precise, one thing
  few: "spin", // playful, juggling
};

interface Round {
  field: keyof StyleProfile;
  /** The dude's question — the cards are the user's reply. */
  title: string;
  left: { label: string; value: NonNullable<StyleProfile[keyof StyleProfile]> };
  right: { label: string; value: NonNullable<StyleProfile[keyof StyleProfile]> };
}

const ROUNDS: Round[] = [
  {
    field: "autonomy",
    title: "When I'm ready to act…",
    left: { label: "Send it", value: "send_it" },
    right: { label: "Show me first", value: "show_me" },
  },
  {
    field: "tone",
    title: "When I explain something…",
    left: { label: "Get to the point", value: "point" },
    right: { label: "Walk me through it", value: "walk" },
  },
  {
    field: "shape",
    title: "When I help out…",
    left: { label: "Focus on one", value: "one" },
    right: { label: "Juggle a few", value: "few" },
  },
];

/**
 * Beat 5 — "This or That." Three rapid binary rounds; the two cards ARE the
 * question (no prompt copy). Tap nods the character toward the pick, the
 * unpicked card slides off, the picked card pulses then fades, and the next
 * round auto-advances ~600ms later.
 */
export function CastStyle({
  character,
  name,
  heroBox,
  jobs,
  ascended,
  onChoose,
  onRoundPicked,
  onDone,
  onBack,
}: {
  character: CastCharacter;
  name: string;
  heroBox: Rect;
  jobs: JobKey[];
  ascended: boolean;
  onChoose?: (value: string) => void;
  onRoundPicked: (style: StyleProfile) => void;
  onDone: (style: StyleProfile) => void;
  onBack: () => void;
}) {
  const [roundIdx, setRoundIdx] = useState(0);
  const [picked, setPicked] = useState<Side | null>(null);
  const [cue, setCue] = useState<{ reaction: Reaction; dir: Side; nonce: number } | null>(null);
  const [style, setStyle] = useState<StyleProfile>({});

  const heldProps: HeldProp[] = ascended
    ? jobs.map((k) => {
        const idx = JOBS.findIndex((j) => j.key === k);
        return { key: JOBS[idx].prop, slot: idx, fly: null };
      })
    : [];

  const round = ROUNDS[roundIdx];

  function choose(side: Side) {
    if (picked) return; // ignore taps mid-transition
    setPicked(side);
    const value = round[side].value;
    setCue({ reaction: VALUE_REACTION[value] ?? "sway", dir: side, nonce: roundIdx + 1 });
    const next: StyleProfile = { ...style, [round.field]: value };
    setStyle(next);
    // Warm up style context on every tap (stub for now).
    void kickoffStyleContext(roundIdx + 1, value);
    onChoose?.(value);
    onRoundPicked(next);

    window.setTimeout(() => {
      if (roundIdx === ROUNDS.length - 1) {
        onDone(next);
      } else {
        setRoundIdx((i) => i + 1);
        setPicked(null);
      }
    }, 600);
  }

  return (
    <motion.div className="cast-beat" style={{ paddingTop: heroBox.top + heroBox.size + 30 }}>
      <button className="cast-back" onClick={onBack} aria-label="Back">
        ‹
      </button>

      <HeroCharacter
        character={character}
        box={heroBox}
        interactive
        heldProps={heldProps}
        ascended={ascended}
        cue={cue}
      />

      <div className="cast-thisthat">
        <AnimatePresence mode="wait">
          <motion.div
            key={roundIdx}
            className="cast-thisthat__group"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            {/* the dude asks — the cards are the user's reply */}
            <p className="cast-thisthat__title">
              <span className="cast-thisthat__asker">{name} asks</span>
              {round.title}
            </p>
            <div className="cast-thisthat__row">
              {(["left", "right"] as const).map((side) => {
              const isPicked = picked === side;
              const isUnpicked = picked !== null && !isPicked;
              return (
                <motion.button
                  key={side}
                  className="cast-vs"
                  onClick={() => choose(side)}
                  animate={
                    isPicked
                      ? { scale: [1, 1.05, 1], opacity: [1, 1, 0] }
                      : isUnpicked
                        ? { opacity: 0, x: side === "left" ? -80 : 80 }
                        : { scale: 1, opacity: 1, x: 0 }
                  }
                  transition={{ duration: 0.5, ease: "easeOut" }}
                  whileHover={picked ? undefined : { y: -6 }}
                  whileTap={picked ? undefined : { scale: 0.97 }}
                >
                  {round[side].label}
                </motion.button>
              );
              })}
            </div>
          </motion.div>
        </AnimatePresence>

        <div className="cast-thisthat__dots">
          {ROUNDS.map((_, i) => (
            <span key={i} className={`cast-dot${i === roundIdx ? " is-on" : ""}`} />
          ))}
        </div>
      </div>
    </motion.div>
  );
}
