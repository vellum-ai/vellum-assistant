import { motion } from "motion/react";

import { JOBS, type Edge, type JobKey } from "@/cast/cast-content";
import { HeroCharacter, type Rect } from "@/cast/cast-hero";
import { Tile, TileGrid } from "@/cast/cast-tiles";
import type { CastCharacter } from "@/cast/cast-roster";

/**
 * Beat 3 — "What will I be doing for you?" The character sits small at top;
 * tapping a job flies its prop in and the character keeps idling with it.
 */
export function CastJob({
  character,
  heroBox,
  job,
  jobEdge,
  onPick,
  onContinue,
  onBack,
}: {
  character: CastCharacter;
  heroBox: Rect;
  job: JobKey | null;
  jobEdge: Edge | null;
  onPick: (key: JobKey) => void;
  onContinue: () => void;
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
        heldFly={jobEdge}
      />

      <motion.p
        className="cast-beat__prompt"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        What will I be doing for you?
      </motion.p>

      <TileGrid>
        {JOBS.map((j) => (
          <Tile
            key={j.key}
            icon={j.prop}
            label={j.label}
            active={job === j.key}
            onClick={() => onPick(j.key)}
          />
        ))}
      </TileGrid>

      <button className="cast-continue" onClick={onContinue}>
        Continue
      </button>
    </motion.div>
  );
}
