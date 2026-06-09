import { motion } from "motion/react";

import { JOBS, type Edge, type JobKey } from "@/cast/cast-content";
import { HeroCharacter, type HeldProp, type Rect } from "@/cast/cast-hero";
import { Tile, TileGrid } from "@/cast/cast-tiles";
import type { CastCharacter } from "@/cast/cast-roster";

/**
 * Beat 3 — "What will I be doing for you?" Multi-select: every chosen job's
 * prop arcs in and clusters around the character, which keeps idling with them.
 * Lives in the LEFT panel of the two-panel layout; picks assemble the
 * locked-input draft on the right, Send fires it, Continue advances to Rather.
 */
export function CastJob({
  character,
  heroBox,
  jobs,
  jobEdges,
  onToggle,
  onContinue,
  onBack,
}: {
  character: CastCharacter;
  heroBox: Rect;
  jobs: JobKey[];
  jobEdges: Record<string, Edge>;
  onToggle: (key: JobKey) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const heldProps: HeldProp[] = jobs.map((k) => {
    const idx = JOBS.findIndex((j) => j.key === k);
    return { key: JOBS[idx].prop, slot: idx, fly: jobEdges[k] ?? null };
  });
  const ascended = jobs.length === JOBS.length;

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
        ascended={ascended}
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
            active={jobs.includes(j.key)}
            onClick={() => onToggle(j.key)}
          />
        ))}
      </TileGrid>

      <button className="cast-continue" onClick={onContinue}>
        Continue
      </button>
    </motion.div>
  );
}
