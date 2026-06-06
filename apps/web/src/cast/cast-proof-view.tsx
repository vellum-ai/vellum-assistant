import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CastAvatar } from "@/cast/cast-avatar";
import { JOBS, type JobKey, type RatherKey } from "@/cast/cast-content";
import { HeroCharacter, type HeldProp, type Rect } from "@/cast/cast-hero";
import { CastProp } from "@/cast/cast-prop-art";
import {
  generateArtifact,
  generateFullArtifact,
  generateReceipt,
  type Artifact,
  type Picks,
  type Receipt,
} from "@/cast/cast-proof";
import type { StyleProfile } from "@/cast/cast-hooks";
import type { CastCharacter } from "@/cast/cast-roster";

/**
 * Beat 6 — Proof. The character lands center, settles, then holds out an
 * artifact. Below it, two stacked elements fade in: the RECEIPT (observation →
 * inference → one-tap offer) and the ARTIFACT card. Tapping the card's Open
 * button surfaces the full artifact in an overlay, revealed line by line.
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
  onBack,
}: {
  character: CastCharacter;
  box: Rect;
  jobs: JobKey[];
  rathers: RatherKey[];
  style: StyleProfile;
  ascended: boolean;
  assistantId: string | null;
  onAction: (which: "offer" | "artifact" | "save") => void;
  onBack: () => void;
}) {
  const [showProp, setShowProp] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const propKey = jobs.length
    ? (JOBS.find((j) => j.key === jobs[0])?.prop ?? "book")
    : "book";

  const heldProps: HeldProp[] = ascended
    ? jobs.map((k) => {
        const idx = JOBS.findIndex((j) => j.key === k);
        return { key: JOBS[idx].prop, slot: idx, fly: null };
      })
    : [];

  useEffect(() => {
    const t = setTimeout(() => setShowProp(true), 600);
    return () => clearTimeout(t);
  }, []);

  // Fire all three generations once on entering Proof. The picks are fixed for
  // the life of this beat, so this runs on mount only (jobs/rathers/style are
  // fresh array/object references each render and would otherwise re-trigger).
  // The full artifact depends on the title/blurb, so it chains off that one;
  // the receipt runs in parallel.
  const picksRef = useRef<Picks>({ jobs, rathers, style });
  useEffect(() => {
    const picks = picksRef.current;
    let alive = true;
    void generateReceipt(picks, assistantId).then((r) => alive && setReceipt(r));
    void generateArtifact(picks, assistantId).then((a) => {
      if (!alive) return;
      setArtifact(a);
      void generateFullArtifact(picks, a, assistantId).then(
        (full) => alive && setFullContent(full),
      );
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <motion.div className="cast-focus" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <button className="cast-back" onClick={onBack} aria-label="Back">
        ‹
      </button>

      <HeroCharacter character={character} box={box} interactive heldProps={heldProps} ascended={ascended} />

      {showProp && !ascended && (
        <motion.div
          className="cast-proof-prop"
          style={{ left: box.left + box.size * 0.62, top: box.top + box.size * 0.52, width: box.size * 0.5 }}
          initial={{ scale: 0, y: -10, rotate: -20, opacity: 0 }}
          animate={{ scale: [0, 1.15, 0.95, 1], y: [-10, 0, 0, 0], rotate: 0, opacity: 1 }}
          transition={{ duration: 0.6, ease: "easeOut", times: [0, 0.5, 0.78, 1] }}
        >
          <CastProp name={propKey} className="cast-prop__art" />
        </motion.div>
      )}

      <div className="cast-proof" style={{ top: box.top + box.size + 28 }}>
        <motion.div
          className="cast-receipt"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.45, ease: "easeOut" }}
        >
          {receipt ? (
            <>
              <p className="cast-receipt__line">{receipt.observation}</p>
              <p className="cast-receipt__line">{receipt.inference}</p>
              <p className="cast-receipt__line cast-receipt__offer">{receipt.offer}</p>
              <button className="cast-continue cast-receipt__cta" onClick={() => onAction("offer")}>
                {receipt.verb}
              </button>
            </>
          ) : (
            <ReceiptSkeleton />
          )}
        </motion.div>

        <motion.div
          className="cast-artifact"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.75, duration: 0.45, ease: "easeOut" }}
        >
          {artifact ? (
            <>
              <span className="cast-artifact__icon">
                <CastProp name={propKey} className="cast-prop__art" />
              </span>
              <div className="cast-artifact__body">
                <p className="cast-artifact__title">{artifact.title}</p>
                <p className="cast-artifact__desc">{artifact.description}</p>
              </div>
              <button
                className="cast-artifact__open"
                onClick={() => {
                  setOpen(true);
                  onAction("artifact");
                }}
              >
                Open
              </button>
            </>
          ) : (
            <ArtifactSkeleton />
          )}
        </motion.div>
      </div>

      <AnimatePresence>
        {open && artifact && (
          <ArtifactOverlay
            character={character}
            title={artifact.title}
            content={fullContent}
            onClose={() => setOpen(false)}
            onSave={() => onAction("save")}
          />
        )}
      </AnimatePresence>
    </motion.div>
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

function ReceiptSkeleton() {
  return (
    <div className="cast-skeleton" aria-hidden>
      <span className="cast-skel-line" style={{ width: "82%" }} />
      <span className="cast-skel-line" style={{ width: "94%" }} />
      <span className="cast-skel-line" style={{ width: "70%" }} />
      <span className="cast-skel-btn" />
    </div>
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
