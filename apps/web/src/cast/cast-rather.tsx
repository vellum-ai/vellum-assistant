import { AnimatePresence, motion } from "motion/react";

import { JOBS, RATHERS, type JobKey, type RatherKey } from "@/cast/cast-content";
// (RATHERS used for both the tile list and the ascension check)
import { HeroCharacter, type HeldProp, type MimeState, type Rect } from "@/cast/cast-hero";
import { Tile, TileGrid } from "@/cast/cast-tiles";
import type { CastCharacter } from "@/cast/cast-roster";

/**
 * Beat 4 — "What would you rather be doing right now?" Multi-select: the
 * character keeps the chosen job props in hand and mimes each rather as it's
 * tapped. A beat after the first mime, a card slides up.
 */
export function CastRather({
  character,
  heroBox,
  jobs,
  rathers,
  mime,
  showCard,
  onToggle,
  onAnswer,
  onBack,
}: {
  character: CastCharacter;
  heroBox: Rect;
  jobs: JobKey[];
  rathers: RatherKey[];
  mime: MimeState | null;
  showCard: boolean;
  onToggle: (key: RatherKey) => void;
  onAnswer: (answer: "yeah" | "not-yet") => void;
  onBack: () => void;
}) {
  const heldProps: HeldProp[] = jobs.map((k) => {
    const idx = JOBS.findIndex((j) => j.key === k);
    return { key: JOBS[idx].prop, slot: idx, fly: null };
  });
  const ascended = rathers.length === RATHERS.length;

  return (
    <motion.div className="cast-beat" style={{ paddingTop: heroBox.top + heroBox.size + 22 }}>
      <button className="cast-back" onClick={onBack} aria-label="Back">
        ‹
      </button>

      <HeroCharacter
        character={character}
        box={heroBox}
        interactive
        heldProps={heldProps}
        mime={mime}
        ascended={ascended}
      />

      <motion.p
        className="cast-beat__prompt"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        What would you rather be doing right now?
      </motion.p>

      <TileGrid>
        {RATHERS.map((r) => (
          <Tile
            key={r.key}
            icon={r.icon}
            label={r.label}
            active={rathers.includes(r.key)}
            onClick={() => onToggle(r.key)}
          />
        ))}
      </TileGrid>

      <AnimatePresence>
        {showCard && (
          <motion.div
            className="cast-card"
            initial={{ y: "115%" }}
            animate={{ y: 0 }}
            exit={{ y: "115%" }}
            transition={{ type: "spring", stiffness: 280, damping: 30 }}
          >
            <p className="cast-card__copy">Want me to handle the boring stuff so you can?</p>
            <div className="cast-card__actions">
              <button className="cast-card__primary" onClick={() => onAnswer("yeah")}>
                Yeah
              </button>
              <button className="cast-card__secondary" onClick={() => onAnswer("not-yet")}>
                Not yet
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
