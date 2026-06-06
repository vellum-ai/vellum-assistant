import { memo, useCallback, useEffect, useRef, useState } from "react";
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

/** The crowd floor spans wider than the viewport so characters bleed off both
 * edges ("already outside the window"). The cell is a FIXED pixel size, so
 * resizing only adds/removes whole columns of same-size characters — the dudes
 * never scale; the window just reveals more. */
const FLOOR_W = 1.7; // floor over-extends to this fraction of the viewport
const CELL = 132; // fixed on-screen cell size (px) — constant across resizes
const GAP = 2;
function colsFor(width: number): number {
  return Math.max(6, Math.min(40, Math.ceil((width * FLOOR_W) / CELL)));
}
function rowsFor(height: number): number {
  return Math.max(10, Math.min(30, Math.ceil(height / 70) + 1));
}

/** Where a picked dude is raised to: anchored at its own tile, lifted up and
 * scaled up modestly so it pops out of the crowd in place — not a jump to a
 * centered "new page". Clamped to stay fully on-screen with room above for the
 * name. */
function raiseBoxFor(tile: Rect, panelW: number, panelH: number): Rect {
  const size = Math.max(150, Math.min(248, tile.size * 1.9));
  const cx = tile.left + tile.size / 2;
  const cy = tile.top + tile.size / 2;
  const left = Math.max(12, Math.min(panelW - size - 12, cx - size / 2));
  // lift up ~0.7×size from where it stood; keep the head (and name above it)
  // clear of the top and don't sink past mid-screen
  const top = Math.max(86, Math.min(panelH * 0.46, cy - size * 0.7));
  return { left, top, size };
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
  // Where the picked dude is raised TO — computed from its tile so it lifts in
  // place (a bit up + bigger) rather than flying to a centered "new page".
  const [raiseBox, setRaiseBox] = useState<Rect | null>(null);
  const [buildOpen, setBuildOpen] = useState(false);

  const [boxes, setBoxes] = useState(() => {
    const { w, h } = win();
    return { top: topBoxFor(w, h) };
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
      setBoxes({ top: topBoxFor(w, h) });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearBeatTimers();
    };
  }, []);

  const { cols, rows } = grid;
  const visible = CAST.slice(0, Math.min(cols * rows, 600));
  const inGrid = phase === "grid";
  // The crowd stays as a dimmed backdrop while a pick is elevated on its podium
  // (Beat 2), then fully clears for the deeper beats so they read as their own
  // steps.
  const floorOpacity = inGrid ? 1 : phase === "flying" || phase === "focus" ? 0.4 : 0;
  const name = selected ? (names[selected.id] ?? selected.name) : "";
  // Nullable on this public route (no ActiveAssistantGate); the proof beat's
  // model calls fall back to local generation when it's absent.
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();

  // "Pick me" — while the grid is idle, a random dude jumps every ~5s to grab
  // attention (paused while hovering or once a pick is made).
  const [jumpingId, setJumpingId] = useState<string | null>(null);
  const hoveringRef = useRef(false);
  const lastJumpRef = useRef<string | null>(null);
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);
  useEffect(() => {
    if (!inGrid) return;
    const tick = window.setInterval(() => {
      if (hoveringRef.current || document.visibilityState !== "visible") return;
      const pool = visibleRef.current.filter((c) => c.id !== lastJumpRef.current);
      const choice = pool[Math.floor(Math.random() * pool.length)];
      if (!choice) return;
      lastJumpRef.current = choice.id;
      setJumpingId(choice.id);
      window.setTimeout(() => setJumpingId((id) => (id === choice.id ? null : id)), 700);
    }, 5000);
    return () => window.clearInterval(tick);
  }, [inGrid]);

  // Esc returns from the elevated (pedestal) view back to the grid.
  useEffect(() => {
    if (phase !== "focus") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") backToGrid();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

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

  const pick = useCallback((char: CastCharacter, el: HTMLElement) => {
    const panel = panelRef.current;
    if (!panel) return;
    const p = panel.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const size = Math.min(r.width, r.height);
    const from: Rect = {
      left: r.left - p.left + (r.width - size) / 2,
      top: r.top - p.top + (r.height - size) / 2,
      size,
    };
    const to = raiseBoxFor(from, p.width, p.height);
    setFlyFrom(from);
    setRaiseBox(to);
    // Tighten + glide the spotlight onto the raised dude (in place, not center).
    const spot = spotlightRef.current;
    if (spot) {
      spot.classList.add("is-settling");
      spot.style.setProperty("--mx", `${to.left + to.size / 2}px`);
      spot.style.setProperty("--my", `${to.top + to.size / 2}px`);
    }
    setSelected(char);
    setPhase("flying");
  }, []);

  function backToGrid() {
    clearBeatTimers();
    cardScheduled.current = false;
    spotlightRef.current?.classList.remove("is-settling");
    setPhase("grid");
    setSelected(null);
    setFlyFrom(null);
    setRaiseBox(null);
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
    // Cast is dark-only — semantic tokens resolve to their dark values within
    // this subtree, giving the "cave" palette regardless of the app theme.
    <div className="cast-stage" data-theme="dark">
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
          onPointerEnter={() => (hoveringRef.current = true)}
          onPointerLeave={() => (hoveringRef.current = false)}
        >
          <motion.div
            className="cast-floor"
            style={{
              // fixed-px tracks → constant dude size; width is the exact sum so
              // the centered floor overflows the viewport rather than stretching
              width: `${cols * CELL + (cols - 1) * GAP}px`,
              gridTemplateColumns: `repeat(${cols}, ${CELL}px)`,
              columnGap: `${GAP}px`,
            }}
            animate={{ opacity: floorOpacity }}
            transition={{ duration: 0.45, ease: "easeOut" }}
          >
            {visible.map((c) => (
              <Billboard
                key={c.id}
                character={c}
                dimmed={!inGrid && selected?.id === c.id}
                jumping={jumpingId === c.id}
                onPick={pick}
              />
            ))}
          </motion.div>

          <div className="cast-spotlight" ref={spotlightRef} />
        </div>

        {/* Flying clone — short in-place rise from the tile to the raise box */}
        <AnimatePresence>
          {phase === "flying" && flyFrom && raiseBox && selected && (
            <motion.div
              className="cast-fly"
              initial={{ left: flyFrom.left, top: flyFrom.top, width: flyFrom.size, height: flyFrom.size }}
              animate={{ left: raiseBox.left, top: raiseBox.top, width: raiseBox.size, height: raiseBox.size }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              onAnimationComplete={() => setPhase("focus")}
            >
              <CastAvatar character={selected} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Beat 2 — named (raised in place) */}
        {phase === "focus" && selected && raiseBox && (
          <CastFocus
            character={selected}
            name={name}
            box={raiseBox}
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

const Billboard = memo(function Billboard({
  character,
  dimmed,
  jumping,
  onPick,
}: {
  character: CastCharacter;
  dimmed: boolean;
  jumping: boolean;
  onPick: (c: CastCharacter, el: HTMLElement) => void;
}) {
  if (dimmed) {
    return <div className="cast-cell" style={{ visibility: "hidden" }} aria-hidden />;
  }
  return (
    <button
      type="button"
      className={`cast-cell${jumping ? " is-jumping" : ""}`}
      aria-label={`Choose ${character.name}`}
      onClick={(e) => onPick(character, e.currentTarget)}
    >
      <span className="cast-cell__stand">
        <span className="cast-idle">
          {/* `is-jumping` swaps in the bigger attention jump over the idle bob */}
          <span className="cast-hover" data-anim={character.hover}>
            <CastAvatar character={character} />
          </span>
        </span>
      </span>
    </button>
  );
});

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

  // A modest riser under the dude + the name above its head — both anchored to
  // the dude's own column so the raise reads as "in place".
  const dudeCx = box.left + box.size / 2;
  const podW = box.size * 1.32;
  const podH = box.size * 0.42;
  const podTop = box.top + box.size * 0.82;
  const podLeft = dudeCx - podW / 2;
  const nameTop = Math.max(10, box.top - 50);

  return (
    <motion.div className="cast-focus">
      {/* click-away on the dim crowd lowers the pick back into the grid */}
      <button
        className="cast-focus__scrim"
        aria-label="Back to grid"
        onClick={onBack}
      />

      <button className="cast-back" onClick={onBack} aria-label="Back to grid">
        ‹
      </button>

      {/* podium the pick is elevated onto — rises in under the landing dude */}
      <motion.div
        className="cast-podium"
        style={{ left: podLeft, top: podTop, width: podW, height: podH }}
        initial={{ opacity: 0, y: 26, scaleX: 0.7 }}
        animate={{ opacity: 1, y: 0, scaleX: 1 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="cast-podium__glow" />
        <svg className="cast-podium__art" viewBox="0 0 220 130" preserveAspectRatio="xMidYMin meet">
          <ellipse cx="110" cy="100" rx="80" ry="16" fill="rgba(0,0,0,0.45)" />
          <path d="M22 30 H198 V86 A88 26 0 0 1 22 86 Z" fill="var(--surface-lift)" />
          <ellipse cx="110" cy="30" rx="88" ry="26" fill="var(--surface-active)" />
          <ellipse cx="110" cy="27" rx="68" ry="17" fill="rgba(255,255,255,0.05)" />
        </svg>
      </motion.div>

      <HeroCharacter character={character} box={box} interactive autoReact />

      {/* name above the dude's head, anchored over its column */}
      <motion.div
        className="cast-name cast-name--above"
        style={{ left: dudeCx, top: nameTop }}
        initial={{ opacity: 0, y: 10, x: "-50%" }}
        animate={{ opacity: 1, y: 0, x: "-50%" }}
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
