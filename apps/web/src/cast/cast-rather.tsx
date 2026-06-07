import { motion } from "motion/react";

import { JOBS, RATHERS, type JobKey, type RatherKey } from "@/cast/cast-content";
// (RATHERS used for both the tile list and the ascension check)
import { HeroCharacter, type HeldProp, type MimeState, type Rect } from "@/cast/cast-hero";
import { Tile, TileGrid } from "@/cast/cast-tiles";
import type { CastCharacter } from "@/cast/cast-roster";

/**
 * Rather — "What would you rather be doing right now?" Single-select: the
 * character keeps the chosen job props in hand and mimes the picked rather,
 * arcing its prop onto the character. Continue advances to Proof.
 */
export function CastRather({
  character,
  heroBox,
  jobs,
  rathers,
  mime,
  onToggle,
  onContinue,
  onBack,
}: {
  character: CastCharacter;
  heroBox: Rect;
  jobs: JobKey[];
  rathers: RatherKey[];
  mime: MimeState | null;
  onToggle: (key: RatherKey) => void;
  onContinue: () => void;
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

      <button className="cast-continue" onClick={onContinue}>
        Continue
      </button>
    </motion.div>
  );
}
