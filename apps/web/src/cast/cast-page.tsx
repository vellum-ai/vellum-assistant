import { useEffect, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";

import { CastAvatar } from "@/cast/cast-avatar";
import { REACTIONS } from "@/cast/cast-reactions";
import type { CastCharacter } from "@/cast/cast-roster";
import { CAST } from "@/cast/cast-roster";
import "@/cast/cast.css";

/**
 * Cast — a two-beat activation prototype.
 *
 * Beat 1: a grid of characters, each idling and previewing personality on
 *         hover. Tap zooms one to center and fades the rest.
 * Beat 2: the picked character, named, performing an autonomous reaction tied
 *         to its eyes. Name is editable inline; Continue is a no-op (logs).
 *
 * Pure front-end. No backend, no Vellum surfaces wired in.
 */
export function CastPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [buildOpen, setBuildOpen] = useState(false);
  // Local name overrides from inline editing, keyed by character id.
  const [names, setNames] = useState<Record<string, string>>({});

  const selected = CAST.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="cast-stage">
      <div className="cast-panel">
        <LayoutGroup>
          {!selected && (
            <header className="cast-panel__header">
              <h1 className="cast-panel__title">Meet the Cast</h1>
              <p className="cast-panel__subtitle">Pick the one that feels like yours.</p>
            </header>
          )}

          <div className="cast-grid" style={{ pointerEvents: selected ? "none" : "auto" }}>
            {CAST.map((c) => (
              <CastTile
                key={c.id}
                character={c}
                hidden={c.id === selectedId}
                faded={selected !== null && c.id !== selectedId}
                onSelect={() => setSelectedId(c.id)}
              />
            ))}
          </div>

          <AnimatePresence>
            {selected && (
              <CastFocus
                key={selected.id}
                character={selected}
                name={names[selected.id] ?? selected.name}
                onRename={(next) =>
                  setNames((prev) => ({ ...prev, [selected.id]: next }))
                }
                onBack={() => setSelectedId(null)}
              />
            )}
          </AnimatePresence>
        </LayoutGroup>

        {!selected && (
          <button className="cast-build-link" onClick={() => setBuildOpen(true)}>
            ＋ Build your own
          </button>
        )}

        <AnimatePresence>
          {buildOpen && <BuildModal onClose={() => setBuildOpen(false)} />}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ---------------- Beat 1: grid tile ---------------- */

function CastTile({
  character,
  hidden,
  faded,
  onSelect,
}: {
  character: CastCharacter;
  hidden: boolean;
  faded: boolean;
  onSelect: () => void;
}) {
  // The selected tile leaves an empty cell so the grid keeps its shape while
  // the character flies to center (its layoutId is adopted by the focus view).
  if (hidden) {
    return <div className="cast-tile" style={{ visibility: "hidden" }} aria-hidden />;
  }

  return (
    <motion.button
      type="button"
      className="cast-tile"
      onClick={onSelect}
      aria-label={`Choose ${character.name}`}
      animate={{ opacity: faded ? 0 : 1, scale: faded ? 0.9 : 1 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
    >
      <motion.div className="cast-tile__box" layoutId={character.id}>
        <div className="cast-idle">
          <div className="cast-hover" data-anim={character.hover}>
            <CastAvatar character={character} />
          </div>
        </div>
      </motion.div>
    </motion.button>
  );
}

/* ---------------- Beat 2: focus ---------------- */

type ReactionPhase = "enter" | "intro" | "loop";

function CastFocus({
  character,
  name,
  onRename,
  onBack,
}: {
  character: CastCharacter;
  name: string;
  onRename: (next: string) => void;
  onBack: () => void;
}) {
  const [phase, setPhase] = useState<ReactionPhase>("enter");
  const [editing, setEditing] = useState(false);
  const reaction = REACTIONS[character.reaction];

  // Let the zoom settle, then start the autonomous reaction. The name slides
  // in on the same beat (~300ms after the zoom).
  useEffect(() => {
    const t = setTimeout(() => setPhase("intro"), 420);
    return () => clearTimeout(t);
  }, []);

  const reactionAnimate =
    phase === "intro"
      ? reaction.intro.animate
      : phase === "loop"
        ? reaction.loop.animate
        : {};
  const reactionTransition =
    phase === "intro" ? reaction.intro.transition : reaction.loop.transition;

  return (
    <motion.div
      className="cast-focus"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      <button className="cast-back" onClick={onBack} aria-label="Back to grid">
        ‹
      </button>

      <div className="cast-focus__avatar-slot">
        <motion.div className="cast-focus__box" layoutId={character.id}>
          <motion.div
            style={{ width: "100%", height: "100%" }}
            animate={reactionAnimate}
            transition={reactionTransition}
            onAnimationComplete={() => {
              if (phase === "intro") setPhase("loop");
            }}
          >
            <CastAvatar character={character} />
          </motion.div>
        </motion.div>

        {/* the grumpy yawn gets a little Zzz */}
        <AnimatePresence>
          {character.reaction === "yawn" && phase === "intro" && (
            <motion.div
              className="cast-zzz"
              initial={{ opacity: 0, y: 0, scale: 0.6 }}
              animate={{ opacity: [0, 1, 1, 0], y: -34, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.5, ease: "easeOut" }}
            >
              z z Z
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <motion.div
        className="cast-name"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.32, duration: 0.4, ease: "easeOut" }}
      >
        {editing ? (
          <input
            className="cast-name__input"
            autoFocus
            defaultValue={name}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v) onRename(v);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <>
            <button className="cast-name__text" onClick={() => setEditing(true)}>
              {name}
            </button>
            <p className="cast-name__hint">tap to rename</p>
          </>
        )}
      </motion.div>

      <button
        className="cast-continue"
        onClick={() => {
          console.log("[Cast] Continue", { id: character.id, name });
        }}
      >
        Continue
      </button>
    </motion.div>
  );
}

/* ---------------- Placeholder "Build your own" modal ---------------- */

function BuildModal({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <motion.div
      className="cast-modal__scrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      ref={ref}
    >
      <motion.div
        className="cast-modal"
        initial={{ opacity: 0, y: 16, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.96 }}
      >
        <h2>Build your own</h2>
        <p>
          This is where the existing avatar customization panel (body, eyes,
          color) will open. Placeholder for the prototype.
        </p>
        <button onClick={onClose}>Got it</button>
      </motion.div>
    </motion.div>
  );
}
