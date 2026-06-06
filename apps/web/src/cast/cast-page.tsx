import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { CastAvatar } from "@/cast/cast-avatar";
import {
  EDGES,
  RATHERS,
  type Edge,
  type JobKey,
  type RatherKey,
} from "@/cast/cast-content";
import { HeroCharacter, type MimeState, type Rect } from "@/cast/cast-hero";
import {
  kickoffJobContext,
  kickoffRatherContext,
  kickoffStyleContext,
  type StyleProfile,
} from "@/cast/cast-hooks";
import { CastJob } from "@/cast/cast-job";
import { CastProof } from "@/cast/cast-proof-view";
import { CastRather } from "@/cast/cast-rather";
import { CastStyle } from "@/cast/cast-style";
import type { CastCharacter } from "@/cast/cast-roster";
import { CAST } from "@/cast/cast-roster";
import { useAssistantSelectionStore } from "@/assistant/selection-store";
import "@/cast/cast.css";

type Phase = "grid" | "flying" | "focus" | "job" | "rather" | "style" | "done";

/** Columns and rows derive from the window so the crowd fills it at any size. */
function colsFor(width: number): number {
  return Math.max(4, Math.min(16, Math.round(width / 134)));
}
function rowsFor(height: number): number {
  return Math.max(10, Math.min(20, Math.round(height / 74)));
}

/** Beat 2 hero box: centered, large. */
function focusBoxFor(w: number, h: number): Rect {
  const size = Math.max(220, Math.min(360, Math.min(w, h) * 0.34));
  return { left: w / 2 - size / 2, top: h * 0.26, size };
}
/** Beats 3/4 hero box: smaller, near the top. */
function topBoxFor(w: number, h: number): Rect {
  const size = Math.max(120, Math.min(176, Math.min(w, h) * 0.2));
  return { left: w / 2 - size / 2, top: h * 0.05, size };
}

const win = () => ({
  w: typeof window === "undefined" ? 1280 : window.innerWidth,
  h: typeof window === "undefined" ? 900 : window.innerHeight,
});

export function CastPage() {
  const panelRef = useRef<HTMLDivElement>(null);
  const spotlightRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  const [phase, setPhase] = useState<Phase>("grid");
  const [selected, setSelected] = useState<CastCharacter | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [flyFrom, setFlyFrom] = useState<Rect | null>(null);
  const [buildOpen, setBuildOpen] = useState(false);

  const [boxes, setBoxes] = useState(() => {
    const { w, h } = win();
    return { focus: focusBoxFor(w, h), top: topBoxFor(w, h) };
  });
  const [grid, setGrid] = useState(() => {
    const { w, h } = win();
    return { cols: colsFor(w), rows: rowsFor(h) };
  });

  // Picks (persisted in component state for later beats). Both steps are
  // multi-select.
  const [jobs, setJobs] = useState<JobKey[]>([]);
  const [jobEdges, setJobEdges] = useState<Record<string, Edge>>({});
  const [rathers, setRathers] = useState<RatherKey[]>([]);
  const [style, setStyle] = useState<StyleProfile>({});
  const [mime, setMime] = useState<MimeState | null>(null);
  const [showCard, setShowCard] = useState(false);
  const tapRef = useRef(0);
  const mimeTimer = useRef<number | undefined>(undefined);
  const cardTimer = useRef<number | undefined>(undefined);
  const cardScheduled = useRef(false);
  const clearBeatTimers = () => {
    clearTimeout(mimeTimer.current);
    clearTimeout(cardTimer.current);
  };

  useEffect(() => {
    const onResize = () => {
      const { w, h } = win();
      setGrid({ cols: colsFor(w), rows: rowsFor(h) });
      setBoxes({ focus: focusBoxFor(w, h), top: topBoxFor(w, h) });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearBeatTimers();
    };
  }, []);

  const { cols, rows } = grid;
  const visible = CAST.slice(0, Math.min(cols * rows, 260));
  const inGrid = phase === "grid";
  const name = selected ? (names[selected.id] ?? selected.name) : "";
  // Nullable on this public route (no ActiveAssistantGate); the proof beat's
  // model calls fall back to local generation when it's absent.
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();

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
    setSelected(char);
    setPhase("flying");
  }

  function backToGrid() {
    clearBeatTimers();
    cardScheduled.current = false;
    setPhase("grid");
    setSelected(null);
    setFlyFrom(null);
    setJobs([]);
    setJobEdges({});
    setRathers([]);
    setMime(null);
    setShowCard(false);
  }

  function goToRather() {
    setPhase("rather");
  }

  // Beat 3: toggle a job. Each newly-added job keeps a stable fly-in edge so its
  // prop arcs in once and then stays clustered around the character.
  function toggleJob(key: JobKey) {
    const next = jobs.includes(key) ? jobs.filter((k) => k !== key) : [...jobs, key];
    setJobs(next);
    setJobEdges((prev) =>
      prev[key] ? prev : { ...prev, [key]: EDGES[tapRef.current++ % EDGES.length] },
    );
    // Warm up job context in the background (stub for now).
    void kickoffJobContext(next);
  }

  // Beat 4: toggle a rather. Adding one plays its mime (transient) and, the
  // first time, schedules the card.
  function toggleRather(key: RatherKey) {
    const has = rathers.includes(key);
    const next = has ? rathers.filter((k) => k !== key) : [...rathers, key];
    setRathers(next);
    // Warm up rather context in the background (stub for now).
    void kickoffRatherContext(next);
    if (has) return;
    const choice = RATHERS.find((r) => r.key === key)!;
    const nonce = (tapRef.current += 1);
    setMime({ rather: choice, edge: EDGES[nonce % EDGES.length], nonce });
    clearTimeout(mimeTimer.current);
    mimeTimer.current = window.setTimeout(() => setMime(null), 1500);
    // Card slides up a beat after the FIRST rather pick (scheduled once, so
    // rapid multi-select doesn't keep pushing it out).
    if (!cardScheduled.current) {
      cardScheduled.current = true;
      cardTimer.current = window.setTimeout(() => setShowCard(true), 2500);
    }
  }

  function answer(a: "yeah" | "not-yet") {
    console.log("[Cast] answer", {
      character: selected?.id,
      name,
      jobs,
      rathers,
      answer: a,
    });
    if (a === "yeah") {
      clearBeatTimers();
      setShowCard(false);
      setMime(null);
      setPhase("style");
    }
  }

  // Beat 5: each round picked warms style context; the final round transitions
  // out to whatever comes next (placeholder "done" route for now).
  function onStyleRound(next: StyleProfile) {
    setStyle(next);
    void kickoffStyleContext(next);
  }
  function onStyleDone(next: StyleProfile) {
    // The final round's kickoffStyleContext already fired via onStyleRound; here
    // we only persist + transition out.
    setStyle(next);
    console.log("[Cast] complete", { character: selected?.id, name, jobs, rathers, style: next });
    setPhase("done");
  }

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

          <div className="cast-spotlight" ref={spotlightRef} />
        </div>

        {/* Flying clone — screen-space FLIP from tapped tile to center */}
        <AnimatePresence>
          {phase === "flying" && flyFrom && selected && (
            <motion.div
              className="cast-fly"
              initial={{ left: flyFrom.left, top: flyFrom.top, width: flyFrom.size, height: flyFrom.size }}
              animate={{ left: boxes.focus.left, top: boxes.focus.top, width: boxes.focus.size, height: boxes.focus.size }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              onAnimationComplete={() => setPhase("focus")}
            >
              <CastAvatar character={selected} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Beat 2 — named */}
        {phase === "focus" && selected && (
          <CastFocus
            character={selected}
            name={name}
            box={boxes.focus}
            onRename={(next) => setNames((prev) => ({ ...prev, [selected.id]: next }))}
            onContinue={() => setPhase("job")}
            onBack={backToGrid}
          />
        )}

        {/* Beat 3 — what will I be doing for you? (multi-select) */}
        {phase === "job" && selected && (
          <CastJob
            character={selected}
            heroBox={boxes.top}
            jobs={jobs}
            jobEdges={jobEdges}
            onToggle={toggleJob}
            onContinue={goToRather}
            onBack={() => setPhase("focus")}
          />
        )}

        {/* Beat 4 — rather (multi-select) */}
        {phase === "rather" && selected && (
          <CastRather
            character={selected}
            heroBox={boxes.top}
            jobs={jobs}
            rathers={rathers}
            mime={mime}
            showCard={showCard}
            onToggle={toggleRather}
            onAnswer={answer}
            onBack={() => {
              clearBeatTimers();
              cardScheduled.current = false;
              setMime(null);
              setShowCard(false);
              setPhase("job");
            }}
          />
        )}

        {/* Beat 5 — this or that */}
        {phase === "style" && selected && (
          <CastStyle
            character={selected}
            heroBox={boxes.top}
            jobs={jobs}
            ascended={rathers.length === RATHERS.length}
            onRoundPicked={onStyleRound}
            onDone={onStyleDone}
            onBack={() => setPhase("rather")}
          />
        )}

        {/* Beat 6 — proof */}
        {phase === "done" && selected && (
          <CastProof
            character={selected}
            box={boxes.top}
            jobs={jobs}
            rathers={rathers}
            style={style}
            ascended={rathers.length === RATHERS.length}
            assistantId={assistantId}
            onAction={(which) => {
              console.log("[Cast] proof action", {
                which,
                character: selected.id,
                name,
                jobs,
                rathers,
                style,
              });
            }}
            onBack={() => setPhase("style")}
          />
        )}

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
  if (dimmed) {
    return <div className="cast-cell" style={{ visibility: "hidden" }} aria-hidden />;
  }
  return (
    <button
      type="button"
      className="cast-cell"
      aria-label={`Choose ${character.name}`}
      onClick={(e) => onPick(character, e.currentTarget)}
    >
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

/* ---------------- Beat 2: focus / named ---------------- */

function CastFocus({
  character,
  name,
  box,
  onRename,
  onContinue,
  onBack,
}: {
  character: CastCharacter;
  name: string;
  box: Rect;
  onRename: (next: string) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <motion.div className="cast-focus">
      <button className="cast-back" onClick={onBack} aria-label="Back to grid">
        ‹
      </button>

      <HeroCharacter character={character} box={box} interactive autoReact />

      <motion.div
        className="cast-name"
        style={{ top: box.top + box.size + 28 }}
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
          <button
            className="cast-name__edit"
            onClick={() => setEditing(true)}
            aria-label={`Rename ${name}`}
          >
            <span className="cast-name__text">{name}</span>
            <svg className="cast-name__pencil" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
              />
            </svg>
          </button>
        )}
      </motion.div>

      <button className="cast-continue" onClick={onContinue}>
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
