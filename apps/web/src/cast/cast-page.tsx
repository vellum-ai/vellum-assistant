import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { CastAvatar } from "@/cast/cast-avatar";
import { REACTIONS } from "@/cast/cast-reactions";
import type { CastCharacter } from "@/cast/cast-roster";
import { CAST } from "@/cast/cast-roster";
import "@/cast/cast.css";

type Phase = "grid" | "flying" | "focus";
interface Rect {
  left: number;
  top: number;
  size: number;
}

/** Columns and rows derive from the window so the crowd packs tight and fills
 * the whole window — receding up to the high horizon — at any size. */
function colsFor(width: number): number {
  return Math.max(4, Math.min(16, Math.round(width / 134)));
}
function rowsFor(height: number): number {
  return Math.max(10, Math.min(20, Math.round(height / 74)));
}

/** Where the picked character lands, sized to the actual window. */
function targetFor(panelW: number, panelH: number): Rect {
  const size = Math.max(220, Math.min(360, Math.min(panelW, panelH) * 0.34));
  return { left: panelW / 2 - size / 2, top: panelH * 0.26, size };
}

/**
 * Cast — a two-beat activation prototype.
 *
 * Beat 1: a packed crowd of characters standing on a ground plane viewed from
 *         ~35° (CSS perspective). Each idles, previews personality on hover,
 *         and on tap zooms out of the crowd to center.
 * Beat 2: the picked character, named, performing an autonomous reaction tied
 *         to its eyes. Name is editable inline; Continue logs to console.
 *
 * Pure front-end. No backend, no Vellum surfaces wired in.
 */
export function CastPage() {
  const panelRef = useRef<HTMLDivElement>(null);
  const spotlightRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const [selected, setSelected] = useState<CastCharacter | null>(null);
  const [phase, setPhase] = useState<Phase>("grid");
  const [flyFrom, setFlyFrom] = useState<Rect | null>(null);
  const [target, setTarget] = useState<Rect>({ left: 0, top: 0, size: 260 });
  const initW = typeof window === "undefined" ? 1280 : window.innerWidth;
  const initH = typeof window === "undefined" ? 900 : window.innerHeight;
  const [grid, setGrid] = useState(() => ({ cols: colsFor(initW), rows: rowsFor(initH) }));
  const [buildOpen, setBuildOpen] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    const onResize = () =>
      setGrid({ cols: colsFor(window.innerWidth), rows: rowsFor(window.innerHeight) });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const { cols, rows } = grid;
  // Cap the live count so very large windows stay responsive.
  const visible = CAST.slice(0, Math.min(cols * rows, 260));

  // Move the spotlight to the cursor. rAF-throttled and written straight to CSS
  // vars so dragging the light never triggers a React re-render.
  function moveSpotlight(e: React.PointerEvent) {
    const panel = panelRef.current;
    const spot = spotlightRef.current;
    if (!panel || !spot) return;
    const r = panel.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      spot.style.setProperty("--mx", `${x}px`);
      spot.style.setProperty("--my", `${y}px`);
    });
  }

  function pick(char: CastCharacter, el: HTMLElement) {
    const panel = panelRef.current;
    if (!panel) return;
    const p = panel.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const size = Math.min(r.width, r.height);
    setFlyFrom({
      left: r.left - p.left + (r.width - size) / 2,
      top: r.top - p.top + (r.height - size) / 2,
      size,
    });
    setTarget(targetFor(p.width, p.height));
    setSelected(char);
    setPhase("flying");
  }

  function reset() {
    setPhase("grid");
    setSelected(null);
    setFlyFrom(null);
  }

  const inGrid = phase === "grid";

  return (
    <div className="cast-stage">
      <div className="cast-panel" ref={panelRef}>
        {inGrid && (
          <header className="cast-panel__header">
            <h1 className="cast-panel__title">Meet the Cast</h1>
            <p className="cast-panel__subtitle">Pick the one that feels like yours.</p>
          </header>
        )}

        {/* Beat 1 — the crowd on a tilted ground plane */}
        <div
          className="cast-stage3d"
          style={{ pointerEvents: inGrid ? "auto" : "none" }}
          onPointerMove={inGrid ? moveSpotlight : undefined}
        >
          <motion.div
            className="cast-floor"
            style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
            animate={{ opacity: inGrid ? 1 : 0 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
          >
            {visible.map((c) => (
              <Billboard
                key={c.id}
                character={c}
                dimmed={!inGrid && selected?.id === c.id}
                onPick={pick}
              />
            ))}
          </motion.div>

          {/* Spotlight: a pool of light that follows the cursor, lifting the
              characters underneath while the rest of the crowd sits in shadow
              so the full field isn't overwhelming. */}
          <div className="cast-spotlight" ref={spotlightRef} />
        </div>

        {/* Flying clone — screen-space FLIP from tapped tile to center */}
        <AnimatePresence>
          {phase === "flying" && flyFrom && selected && (
            <motion.div
              className="cast-fly"
              initial={{ left: flyFrom.left, top: flyFrom.top, width: flyFrom.size, height: flyFrom.size }}
              animate={{ left: target.left, top: target.top, width: target.size, height: target.size }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              onAnimationComplete={() => setPhase("focus")}
            >
              <CastAvatar character={selected} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Beat 2 — named + reaction */}
        <AnimatePresence>
          {phase === "focus" && selected && (
            <CastFocus
              key={selected.id}
              character={selected}
              name={names[selected.id] ?? selected.name}
              target={target}
              onRename={(next) => setNames((prev) => ({ ...prev, [selected.id]: next }))}
              onBack={reset}
            />
          )}
        </AnimatePresence>

        {inGrid && (
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

/* ---------------- Beat 1: a standing billboard on the floor ---------------- */

function Billboard({
  character,
  dimmed,
  onPick,
}: {
  character: CastCharacter;
  dimmed: boolean;
  onPick: (c: CastCharacter, el: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      className="cast-cell"
      style={{ visibility: dimmed ? "hidden" : "visible" }}
      aria-label={`Choose ${character.name}`}
      onClick={(e) => onPick(character, e.currentTarget)}
    >
      {/* counter-rotate so the character stands upright facing us */}
      <span className="cast-cell__stand">
        <span className="cast-idle">
          <span className="cast-hover" data-anim={character.hover}>
            <CastAvatar character={character} />
          </span>
        </span>
      </span>
    </button>
  );
}

/* ---------------- Beat 2: focus ---------------- */

type ReactionPhase = "enter" | "intro" | "loop";

function CastFocus({
  character,
  name,
  target,
  onRename,
  onBack,
}: {
  character: CastCharacter;
  name: string;
  target: Rect;
  onRename: (next: string) => void;
  onBack: () => void;
}) {
  const [phase, setPhase] = useState<ReactionPhase>("enter");
  const [editing, setEditing] = useState(false);
  const reaction = REACTIONS[character.reaction];

  // The clone has already landed; start the autonomous reaction (and slide the
  // name in on the same beat).
  useEffect(() => {
    const t = setTimeout(() => setPhase("intro"), 120);
    return () => clearTimeout(t);
  }, []);

  const reactionAnimate =
    phase === "intro" ? reaction.intro.animate : phase === "loop" ? reaction.loop.animate : {};
  const reactionTransition =
    phase === "intro" ? reaction.intro.transition : reaction.loop.transition;

  return (
    <motion.div
      className="cast-focus"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <button className="cast-back" onClick={onBack} aria-label="Back to grid">
        ‹
      </button>

      {/* avatar pinned to the clone's landing box for a seamless hand-off */}
      <div
        className="cast-focus__avatar"
        style={{ left: target.left, top: target.top, width: target.size, height: target.size }}
      >
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
        style={{ top: target.top + target.size + 28 }}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.4, ease: "easeOut" }}
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
