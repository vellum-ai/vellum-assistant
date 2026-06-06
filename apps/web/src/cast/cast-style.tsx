import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { HeroCharacter, type HeldProp, type Rect } from "@/cast/cast-hero";
import type { StyleProfile } from "@/cast/cast-hooks";
import { JOBS, type JobKey } from "@/cast/cast-content";
import type { CastCharacter } from "@/cast/cast-roster";

type Side = "left" | "right";

interface Round {
  field: keyof StyleProfile;
  left: { label: string; value: NonNullable<StyleProfile[keyof StyleProfile]> };
  right: { label: string; value: NonNullable<StyleProfile[keyof StyleProfile]> };
}

const ROUNDS: Round[] = [
  {
    field: "execution",
    left: { label: "Just do it", value: "just_do_it" },
    right: { label: "Show your work", value: "show_work" },
  },
  {
    field: "tone",
    left: { label: "Sharp and fast", value: "sharp" },
    right: { label: "Warm and patient", value: "warm" },
  },
  {
    field: "latitude",
    left: { label: "Surprise me", value: "surprise" },
    right: { label: "Stay in the lines", value: "literal" },
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
  heroBox,
  jobs,
  ascended,
  onRoundPicked,
  onDone,
  onBack,
}: {
  character: CastCharacter;
  heroBox: Rect;
  jobs: JobKey[];
  ascended: boolean;
  onRoundPicked: (style: StyleProfile) => void;
  onDone: (style: StyleProfile) => void;
  onBack: () => void;
}) {
  const [roundIdx, setRoundIdx] = useState(0);
  const [picked, setPicked] = useState<Side | null>(null);
  const [nod, setNod] = useState<{ dir: Side; nonce: number } | null>(null);
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
    setNod({ dir: side, nonce: roundIdx + 1 });
    const next: StyleProfile = { ...style, [round.field]: round[side].value };
    setStyle(next);
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
        nod={nod}
      />

      <div className="cast-thisthat">
        <AnimatePresence mode="wait">
          <motion.div
            key={roundIdx}
            className="cast-thisthat__row"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
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
