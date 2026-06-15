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
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@vellumai/design-library";

import { BlinkingAvatar } from "@/domains/onboarding/cast/cast-shell";
import type { StyleProfile } from "@/domains/onboarding/cast/cast-templates";
import type { CastCharacter } from "@/domains/onboarding/cast/cast-roster";
import type { Rect } from "@/domains/onboarding/cast/cast-hero-types";

type Side = "left" | "right";

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

  // Track the pending auto-advance timer so a Back/unmount before it fires can't
  // call `onDone` after unmount with stale choices.
  const advanceTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current);
      }
    };
  }, []);

  function choose(side: Side) {
    if (picked) return; // ignore taps mid-transition
    setPicked(side);
    const value = round[side].value;
    const next: StyleProfile = { ...style, [round.field]: value };
    setStyle(next);
    onChoose?.(value);
    onRoundPicked(next);

    advanceTimerRef.current = window.setTimeout(() => {
      advanceTimerRef.current = null;
      if (roundIdx === ROUNDS.length - 1) {
        onDone(next);
      } else {
        setRoundIdx((i) => i + 1);
        setPicked(null);
      }
    }, 600);
  }

  function handleBack() {
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    onBack?.();
  }

  return (
    <motion.div className="cast-beat" style={{ paddingTop: heroBox.top + heroBox.size + 30 }}>
      {onBack && (
        <button className="cast-back" onClick={handleBack} aria-label="Back">
          ‹
        </button>
      )}

      {/* `.cast-avatar` is width/height:100%, so it must live in a hero-box-sized
          wrapper or it fills the whole stage. Size it from `heroBox`. */}
      <div
        className="absolute"
        style={{
          left: heroBox.left,
          top: heroBox.top,
          width: heroBox.size,
          height: heroBox.size,
        }}
      >
        <BlinkingAvatar character={character} />
      </div>

      <div className="cast-thisthat">
        <AnimatePresence mode="wait">
          <motion.div
            key={roundIdx}
            className="flex w-full flex-col items-center gap-[var(--app-spacing-lg)]"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            {/* the character asks — the cards are the user's reply */}
            <p className="cast-thisthat__title">
              <span className="mb-[6px] block text-[11px] uppercase tracking-[0.06em] text-[var(--content-tertiary)] [font-family:var(--font-sans),system-ui,sans-serif] [font-weight:560]">
                {name} asks
              </span>
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

        <div className="flex gap-[var(--app-spacing-sm)]">
          {ROUNDS.map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-[7px] w-[7px] rounded-[var(--radius-pill)] bg-[var(--border-element)] transition-[background,transform] duration-200",
                i === roundIdx && "scale-125 bg-[var(--content-default)]",
              )}
            />
          ))}
        </div>
      </div>
    </motion.div>
  );
}
