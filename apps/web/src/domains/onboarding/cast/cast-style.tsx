/**
 * Beat 5 — "This or That." Three rapid binary rounds where the two cards ARE the
 * question (no prompt copy). Tapping a card commits the round's value into the
 * accumulating {@link StyleProfile}, slides the unpicked card off, pulses the
 * picked card, and auto-advances ~600ms later; the final round reports the
 * completed profile.
 *
 * Ported from the prototype's `cast/cast-style.tsx`. The prototype rendered the
 * character through the heavy `cast-hero` `HeroCharacter` (held-prop / reaction
 * mime closure); the productionized cast flow uses the lightweight
 * {@link BlinkingAvatar} from `cast-shell` instead, so the hero-only inputs
 * (`heldProps`, reaction cues) are dropped here and the avatar is positioned via
 * the `heroBox` geometry the orchestrator already passes.
 */
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { BlinkingAvatar } from "@/domains/onboarding/cast/cast-shell";
import type { StyleProfile } from "@/domains/onboarding/cast/cast-templates";
import type { CastCharacter } from "@/domains/onboarding/cast/cast-roster";
import type { Rect } from "@/domains/onboarding/cast/cast-hero-types";

type Side = "left" | "right";

/**
 * Warm up style context on every tap. No-op stub for now — the real
 * implementation kicks off context assembly server-side; the call site is kept
 * so its future wiring stays intact.
 */
function kickoffStyleContext(_round: number, _choice: string): void {}

interface Round {
  field: keyof StyleProfile;
  /** The character's question — the cards are the user's reply. */
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

export function CastStyle({
  character,
  name,
  heroBox,
  onChoose,
  onRoundPicked,
  onDone,
  onBack,
}: {
  character: CastCharacter;
  name: string;
  heroBox: Rect;
  onChoose?: (value: string) => void;
  onRoundPicked: (style: StyleProfile) => void;
  onDone: (style: StyleProfile) => void;
  onBack?: () => void;
}) {
  const [roundIdx, setRoundIdx] = useState(0);
  const [picked, setPicked] = useState<Side | null>(null);
  const [style, setStyle] = useState<StyleProfile>({});

  const round = ROUNDS[roundIdx];

  function choose(side: Side) {
    if (picked) return; // ignore taps mid-transition
    setPicked(side);
    const value = round[side].value;
    const next: StyleProfile = { ...style, [round.field]: value };
    setStyle(next);
    kickoffStyleContext(roundIdx + 1, value);
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
      {onBack && (
        <button className="cast-back" onClick={onBack} aria-label="Back">
          ‹
        </button>
      )}

      <BlinkingAvatar character={character} />

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
            {/* the character asks — the cards are the user's reply */}
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
