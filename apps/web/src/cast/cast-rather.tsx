import { AnimatePresence, motion } from "motion/react";

import { JOBS, RATHERS, type JobKey, type RatherKey } from "@/cast/cast-content";
import { HeroCharacter, type MimeState, type Rect } from "@/cast/cast-hero";
import { Tile, TileGrid } from "@/cast/cast-tiles";
import type { CastCharacter } from "@/cast/cast-roster";

/**
 * Beat 4 — "What would you rather be doing right now?" The character keeps the
 * job prop in hand; tapping a choice flies items in and the character mimes the
 * answer. A beat after the mime, a card slides up.
 */
export function CastRather({
  character,
  heroBox,
  job,
  rather,
  mime,
  showCard,
  onPick,
  onAnswer,
  onBack,
}: {
  character: CastCharacter;
  heroBox: Rect;
  job: JobKey | null;
  rather: RatherKey | null;
  mime: MimeState | null;
  showCard: boolean;
  onPick: (key: RatherKey) => void;
  onAnswer: (answer: "yeah" | "not-yet") => void;
  onBack: () => void;
}) {
  const heldProp = job ? (JOBS.find((j) => j.key === job)?.prop ?? null) : null;

  return (
    <motion.div className="cast-beat" style={{ paddingTop: heroBox.top + heroBox.size + 22 }}>
      <button className="cast-back" onClick={onBack} aria-label="Back">
        ‹
      </button>

      <HeroCharacter
        character={character}
        box={heroBox}
        interactive
        heldProp={heldProp}
        mime={mime}
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
            active={rather === r.key}
            onClick={() => onPick(r.key)}
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
