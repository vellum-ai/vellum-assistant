import { motion } from "motion/react";

import { JOBS, RATHERS, type JobKey, type RatherKey } from "@/cast/cast-content";
// (RATHERS used for both the tile list and the ascension check)
import { HeroCharacter, type HeldProp, type MimeState, type Rect } from "@/cast/cast-hero";
import { Tile, TileGrid } from "@/cast/cast-tiles";
import type { CastCharacter } from "@/cast/cast-roster";

/**
 * Beat 4 — "What would you rather be doing right now?" Multi-select: the
 * character keeps the chosen job props in hand and mimes each rather as it's
 * tapped. Picks assemble the locked-input draft on the right; Send fires the
 * message and, once it streams, the conversation panel shows the "boring stuff"
 * offer that advances to Beat 5.
 */
export function CastRather({
  character,
  heroBox,
  jobs,
  rathers,
  mime,
  onToggle,
  onBack,
}: {
  character: CastCharacter;
  heroBox: Rect;
  jobs: JobKey[];
  rathers: RatherKey[];
  mime: MimeState | null;
  onToggle: (key: RatherKey) => void;
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
    </motion.div>
  );
}
