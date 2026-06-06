import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CastAvatar } from "@/cast/cast-avatar";
import { JOBS, type JobKey, type RatherKey } from "@/cast/cast-content";
import { HeroCharacter, type HeldProp, type Rect } from "@/cast/cast-hero";
import { CastProp, type PropKey } from "@/cast/cast-prop-art";
import {
  generateArtifacts,
  generateFullArtifact,
  resolveAssistantId,
  type Artifact,
  type Picks,
} from "@/cast/cast-proof";
import type { StyleProfile } from "@/cast/cast-hooks";
import type { CastCharacter } from "@/cast/cast-roster";

/**
 * Beat 6 — Proof. The character settles, then presents what it made. Round 3 of
 * This/That shapes this beat:
 *  - shape "one" → a focused dude holding a single item + ONE artifact card.
 *  - shape "few" → a juggling dude (props arcing overhead) + a STACK of 2-3
 *    artifact cards.
 * The receipt (observation → inference → one-tap offer) sits above either way.
 */
export function CastProof({
  character,
  box,
  jobs,
  rathers,
  style,
  ascended,
  assistantId,
  onAction,
  onEndpoint,
  onBack,
}: {
  character: CastCharacter;
  box: Rect;
  jobs: JobKey[];
  rathers: RatherKey[];
  style: StyleProfile;
  ascended: boolean;
  assistantId: string | null;
  onAction: (which: "artifact" | "save") => void;
  onEndpoint: (which: "chat" | "boost") => void;
  onBack: () => void;
}) {
  const few = style.shape === "few";
  const count = few ? 3 : 1;

  const [showProps, setShowProps] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [fullByIdx, setFullByIdx] = useState<Record<number, string | null>>({});
  const resolvedIdRef = useRef<string | null>(null);

  // Props the dude works with: its chosen job props (padded with defaults).
  const DEFAULT_PROPS: PropKey[] = ["book", "laptop", "pen"];
  const jobProps: PropKey[] = jobs.map((k) => JOBS.find((j) => j.key === k)?.prop ?? "book");
  const propKeys: PropKey[] = [...jobProps, ...DEFAULT_PROPS].slice(0, few ? 3 : 1);

  // Ascended easter-egg keeps the whole prop pile clustered.
  const heldProps: HeldProp[] = ascended
    ? jobs.map((k) => {
        const idx = JOBS.findIndex((j) => j.key === k);
        return { key: JOBS[idx].prop, slot: idx, fly: null };
      })
    : [];

  useEffect(() => {
    const t = setTimeout(() => setShowProps(true), 600);
    return () => clearTimeout(t);
  }, []);

  // Generate receipt + artifacts on entering Proof (picks fixed for this beat).
  const picksRef = useRef<Picks>({ jobs, rathers, style });
  useEffect(() => {
    const picks = picksRef.current;
    let alive = true;
    void resolveAssistantId(assistantId).then((id) => {
      if (!alive) return;
      resolvedIdRef.current = id;
      void generateArtifacts(picks, count, id).then((a) => alive && setArtifacts(a));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openArtifact(i: number) {
    setOpenIdx(i);
    onAction("artifact");
    // Lazily generate the full body for this card the first time it's opened.
    if (fullByIdx[i] === undefined && artifacts) {
      setFullByIdx((m) => ({ ...m, [i]: null }));
      void generateFullArtifact(picksRef.current, artifacts[i], resolvedIdRef.current).then(
        (full) => setFullByIdx((m) => ({ ...m, [i]: full })),
      );
    }
  }

  return (
    <motion.div className="cast-focus" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <button className="cast-back" onClick={onBack} aria-label="Back">
        ‹
      </button>

      <HeroCharacter character={character} box={box} interactive heldProps={heldProps} ascended={ascended} />

      {/* the dude presents what it made: juggling (few) or holding one (one) */}
      {showProps && !ascended && (
        few ? (
          <JuggleProps box={box} props={propKeys} />
        ) : (
          <motion.div
            className="cast-proof-prop"
            style={{ left: box.left + box.size * 0.6, top: box.top + box.size * 0.56, width: box.size * 0.5 }}
            initial={{ scale: 0, y: -10, rotate: -20, opacity: 0 }}
            animate={{ scale: [0, 1.15, 0.95, 1], y: [-10, 0, 0, 0], rotate: 0, opacity: 1 }}
            transition={{ duration: 0.6, ease: "easeOut", times: [0, 0.5, 0.78, 1] }}
          >
            <CastProp name={propKeys[0]} className="cast-prop__art" />
          </motion.div>
        )
      )}

      <div className="cast-proof" style={{ top: box.top + box.size + 28 }}>
        {/* artifact card(s): one focused card, or a stack of a few quick wins.
            No receipt — the inference moment lives in the endpoint chat now. */}
        <div className="cast-artifacts">
          {artifacts
            ? artifacts.map((a, i) => (
                <motion.div
                  key={i}
                  className="cast-artifact"
                  initial={{ opacity: 0, y: 18 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.7 + i * 0.12, duration: 0.45, ease: "easeOut" }}
                >
                  <span className="cast-artifact__icon">
                    <CastProp name={propKeys[i % propKeys.length]} className="cast-prop__art" />
                  </span>
                  <div className="cast-artifact__body">
                    <p className="cast-artifact__title">{a.title}</p>
                    <p className="cast-artifact__desc">{a.description}</p>
                  </div>
                  <button className="cast-artifact__open" onClick={() => openArtifact(i)}>
                    Open
                  </button>
                </motion.div>
              ))
            : Array.from({ length: count }).map((_, i) => <ArtifactSkeleton key={i} />)}
        </div>

        {/* Endpoint: drop into real chat, or boost with a prior assistant. */}
        {artifacts && (
          <motion.div
            className="cast-endpoints"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7 + count * 0.12 + 0.15, duration: 0.4, ease: "easeOut" }}
          >
            <button className="cast-endpoints__primary" onClick={() => onEndpoint("chat")}>
              Start chatting
            </button>
            <button className="cast-endpoints__secondary" onClick={() => onEndpoint("boost")}>
              Give me a boost
            </button>
          </motion.div>
        )}
      </div>

      <AnimatePresence>
        {openIdx !== null && artifacts && (
          <ArtifactOverlay
            character={character}
            title={artifacts[openIdx].title}
            content={fullByIdx[openIdx] ?? null}
            onClose={() => setOpenIdx(null)}
            onSave={() => onAction("save")}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ---------------- juggling props (shape "few") ---------------- */

function JuggleProps({ box, props }: { box: Rect; props: PropKey[] }) {
  const size = box.size * 0.36;
  const A = box.size * 0.5; // throw width
  const H = box.size * 0.5; // throw height (kept modest so it stays in frame)
  const dur = 1.25;
  return (
    <div
      className="cast-juggle"
      style={{ left: box.left, top: box.top - box.size * 0.18, width: box.size, height: box.size }}
      aria-hidden
    >
      {props.map((p, i) => {
        const dir = i % 2 === 0 ? 1 : -1;
        return (
          <motion.div
            key={i}
            className="cast-juggle__item"
            style={{ width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2 }}
            initial={{ x: -dir * A, y: 0, rotate: 0 }}
            animate={{ x: [-dir * A, dir * A, -dir * A], y: [0, -H, 0], rotate: [0, dir * 200, dir * 360] }}
            transition={{
              duration: dur,
              repeat: Infinity,
              ease: "easeInOut",
              times: [0, 0.5, 1],
              delay: (i * dur) / props.length,
            }}
          >
            <CastProp name={p} className="cast-prop__art" />
          </motion.div>
        );
      })}
    </div>
  );
}

/* ---------------- Open overlay: full artifact ---------------- */

function ArtifactOverlay({
  character,
  title,
  content,
  onClose,
  onSave,
}: {
  character: CastCharacter;
  title: string;
  content: string | null;
  onClose: () => void;
  onSave: () => void;
}) {
  // Reveal the body line by line once it's available. While `content` is still
  // null the dude scribbles and only the title shows.
  const [revealed, setRevealed] = useState("");
  const streaming = content !== null && revealed.length < content.length;

  useEffect(() => {
    if (content === null) return;
    const lines = content.split("\n");
    let i = 0;
    setRevealed("");
    const id = setInterval(() => {
      i += 1;
      setRevealed(lines.slice(0, i).join("\n"));
      if (i >= lines.length) clearInterval(id);
    }, 90);
    return () => clearInterval(id);
  }, [content]);

  const writing = content === null || streaming;

  return (
    <motion.div
      className="cast-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <button className="cast-overlay__close" onClick={onClose} aria-label="Close">
        ✕
      </button>

      {/* the dude, small and persistent in the corner; scribbles while writing */}
      <div className="cast-overlay__dude">
        <div className={writing ? "cast-scribble" : undefined}>
          <CastAvatar character={character} />
        </div>
        {writing && (
          <span className="cast-overlay__pencil">
            <CastProp name="pen" className="cast-prop__art" />
          </span>
        )}
      </div>

      <motion.div
        className="cast-overlay__sheet"
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 24, opacity: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      >
        <h1 className="cast-overlay__title">{title}</h1>
        <div className="cast-overlay__body">
          {content === null ? (
            <p className="cast-overlay__writing">Writing it out…</p>
          ) : (
            <Markdown remarkPlugins={[remarkGfm]}>{revealed}</Markdown>
          )}
        </div>
        <button className="cast-overlay__save" onClick={onSave}>
          Save
        </button>
      </motion.div>
    </motion.div>
  );
}

function ArtifactSkeleton() {
  return (
    <div className="cast-skeleton cast-skeleton--row" aria-hidden>
      <span className="cast-skel-icon" />
      <div style={{ flex: 1 }}>
        <span className="cast-skel-line" style={{ width: "60%" }} />
        <span className="cast-skel-line" style={{ width: "90%" }} />
      </div>
    </div>
  );
}
