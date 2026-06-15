import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CastAvatar } from "@/domains/onboarding/cast/cast-avatar";
import { JOBS, type JobKey, type RatherKey } from "@/domains/onboarding/cast/cast-content";
import type { Rect } from "@/domains/onboarding/cast/cast-hero-types";
import { CastProp, type PropKey } from "@/domains/onboarding/cast/cast-prop-art";
import {
  generateArtifacts,
  generateFullArtifact,
  resolveAssistantId,
  type Artifact,
  type Picks,
} from "@/domains/onboarding/cast/cast-proof";
import type { StyleProfile } from "@/domains/onboarding/cast/cast-templates";
import type { CastCharacter } from "@/domains/onboarding/cast/cast-roster";

/**
 * Beat 6 — Proof. The character settles, then presents what it made. Round 3 of
 * This/That shapes this beat:
 *  - shape "one" → a focused dude holding a single item + ONE artifact card.
 *  - shape "few" → a juggling dude (props arcing overhead) + a STACK of 2-3
 *    artifact cards.
 * The receipt (observation → inference → one-tap offer) sits above either way.
 *
 * Ported from the prototype's `@/cast/cast-proof-view`. Imports rewritten to
 * base. The prototype rendered the persistent character via the `cast-hero`
 * `HeroCharacter` — a 400-line marketing/demo surface (Super-Saiyan aura,
 * autonomous reaction loop, mime beats, buddies) that base deliberately did NOT
 * lift. Proof only ever used the static avatar + held props, so we render those
 * via the lightweight `ProofHero` below (`CastAvatar` + `CastProp`), keeping the
 * excluded hero closure out of the onboarding flow.
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
        return { key: JOBS[idx].prop, slot: idx };
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

      <ProofHero character={character} box={box} heldProps={heldProps} ascended={ascended} />

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

      <div
        className="cast-proof absolute inset-x-0 bottom-0 flex flex-col items-center gap-[var(--app-spacing-md)] px-[var(--app-spacing-xl)] pb-[28px]"
        style={{ top: box.top + box.size + 28 }}
      >
        {/* artifact card(s): one focused card, or a stack of a few quick wins.
            No receipt — the inference moment lives in the endpoint chat now. */}
        <div className="flex w-[min(520px,100%)] flex-col gap-2.5">
          {artifacts
            ? artifacts.map((a, i) => (
                <motion.div
                  key={i}
                  className="flex w-full items-center gap-[var(--app-spacing-lg)] rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-overlay)] px-[var(--app-spacing-lg)] py-[14px]"
                  initial={{ opacity: 0, y: 18 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.7 + i * 0.12, duration: 0.45, ease: "easeOut" }}
                >
                  <span className="h-11 w-11 flex-shrink-0">
                    <CastProp name={propKeys[i % propKeys.length]} className="cast-prop__art" />
                  </span>
                  <div className="min-w-0 flex-1 text-left">
                    <Typography
                      as="p"
                      variant="body-medium-default"
                      className="mb-[3px] text-[15px] font-[650] leading-normal text-[var(--content-default)]"
                    >
                      {a.title}
                    </Typography>
                    <Typography
                      as="p"
                      variant="body-small-default"
                      className="text-[13px] font-normal leading-[1.4] text-[var(--content-tertiary)]"
                    >
                      {a.description}
                    </Typography>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => openArtifact(i)}
                    className="h-auto flex-shrink-0 rounded-[var(--radius-lg)] bg-[var(--surface-active)] px-[var(--app-spacing-lg)] py-[9px] text-[13px] font-[620] text-[var(--content-default)] hover:bg-[var(--border-element)]"
                  >
                    Open
                  </Button>
                </motion.div>
              ))
            : Array.from({ length: count }).map((_, i) => <ArtifactSkeleton key={i} />)}
        </div>

        {/* Endpoint: drop into real chat, or boost with a prior assistant. */}
        {artifacts && (
          <motion.div
            className="mt-[22px] flex gap-[var(--app-spacing-md)]"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7 + count * 0.12 + 0.15, duration: 0.4, ease: "easeOut" }}
          >
            <Button
              variant="primary"
              onClick={() => onEndpoint("chat")}
              className="h-auto flex-1 rounded-[var(--radius-lg)] py-[14px] text-[15px] font-[640]"
            >
              Start chatting
            </Button>
            <Button
              variant="ghost"
              onClick={() => onEndpoint("boost")}
              className="h-auto flex-1 rounded-[var(--radius-lg)] bg-[var(--surface-hover)] py-[14px] text-[15px] font-[640] text-[var(--content-secondary)] hover:bg-[var(--surface-active)]"
            >
              Give me a boost
            </Button>
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

/* ---------------- ProofHero (static hero substitute) ----------------
 * Lifts only what Proof used from the excluded `cast-hero` `HeroCharacter`:
 * the positioned character box + its held props. None of the marketing-only
 * behaviors (aura, reaction loop, mime, buddies, cue) are reachable from this
 * beat, so they are intentionally dropped. */

/** A held job prop and the fixed slot it occupies around the character. */
interface HeldProp {
  key: PropKey;
  slot: number; // stable index (JOBS order) so props don't reshuffle on removal
}

/** Stable slots ringing the character — one per job, so multiple props cluster
 * around the dude without overlapping. Lifted verbatim from `cast-hero`. */
const HELD_SLOTS: React.CSSProperties[] = [
  { left: "48%", top: "54%", width: "46%" }, // lower-right
  { left: "6%", top: "54%", width: "46%" }, // lower-left
  { left: "64%", top: "26%", width: "42%" }, // right
  { left: "-6%", top: "26%", width: "42%" }, // left
  { left: "27%", top: "68%", width: "46%" }, // bottom
  { left: "60%", top: "-8%", width: "40%" }, // upper-right
  { left: "0%", top: "-8%", width: "40%" }, // upper-left
  { left: "30%", top: "-24%", width: "40%" }, // top
];

function ProofHero({
  character,
  box,
  heldProps,
  ascended,
}: {
  character: CastCharacter;
  box: Rect;
  heldProps: HeldProp[];
  ascended: boolean;
}) {
  // On ascension the dude turns gold — same recolor the prototype hero applied.
  const shown = ascended ? { ...character, color: "yellow" } : character;
  return (
    <motion.div
      className={`cast-hero${ascended ? " is-ascended" : ""}`}
      layoutId="cast-hero"
      style={{ left: box.left, top: box.top, width: box.size, height: box.size }}
    >
      <div className="cast-hero__body">
        <div className="cast-focus-alive">
          <div className="cast-hover" data-anim={character.hover}>
            <CastAvatar character={shown} />
          </div>
        </div>
      </div>

      <AnimatePresence>
        {heldProps.map((hp) => (
          <motion.div
            key={`held-${hp.key}`}
            className="cast-prop"
            style={{ ...HELD_SLOTS[hp.slot % HELD_SLOTS.length], zIndex: 3 }}
            initial={{ scaleX: 0.7, scaleY: 0.7, opacity: 0 }}
            animate={{ scaleX: 1, scaleY: 1, opacity: 1 }}
            exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.2 } }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          >
            <CastProp name={hp.key} className="cast-prop__art" />
          </motion.div>
        ))}
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
      className="cast-overlay absolute inset-0 z-[9] flex justify-center overflow-y-auto"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <Button
        variant="ghost"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-[var(--app-spacing-lg)] top-[var(--app-spacing-lg)] z-[2] h-9 w-9 rounded-[var(--radius-pill)] bg-[var(--surface-hover)] p-0 text-[15px] leading-none text-[var(--content-secondary)] hover:bg-[var(--surface-active)]"
      >
        ✕
      </Button>

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
        className="mx-auto w-[min(620px,100%)] px-[28px] pb-[96px] pt-[64px]"
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 24, opacity: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      >
        <Typography
          as="h1"
          variant="title-large"
          className="mb-5 text-[28px] font-[680] leading-[1.2] tracking-[-0.02em] text-[var(--content-default)]"
        >
          {title}
        </Typography>
        <div className="cast-overlay__body min-h-[120px] text-[16px] leading-[1.75] text-[var(--content-secondary)]">
          {content === null ? (
            <p className="italic text-[var(--content-tertiary)]">Writing it out…</p>
          ) : (
            <Markdown remarkPlugins={[remarkGfm]}>{revealed}</Markdown>
          )}
        </div>
        <Button
          variant="ghost"
          onClick={onSave}
          className="mt-[26px] h-auto rounded-[var(--radius-lg)] border border-[var(--border-element)] bg-[var(--surface-hover)] px-[26px] py-[13px] text-[15px] font-[620] text-[var(--content-default)] hover:bg-[var(--surface-active)]"
        >
          Save
        </Button>
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
