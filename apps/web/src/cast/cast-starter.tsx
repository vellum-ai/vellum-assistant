/**
 * Cast — starter selection (replaces the spotlight crowd as Beat 1).
 *
 * A Pokémon-starter-style line-up: the roster is the set of body shapes from
 * the avatar vocabulary (`BUNDLED_COMPONENTS.bodyShapes`) — the exact shapes
 * the Settings ▸ "Build a Character" modal offers. Picking one uses a shared
 * `layoutId` so the chosen avatar is *pulled out of the line-up* and morphs
 * into the customization card, where the *same* Body / Eyes / Color cycle
 * controls (and Randomize) the modal uses sit over a live preview. Continue
 * hands a fully-built character to the rest of the flow.
 */

import { ChevronLeft, ChevronRight, Dices, Pencil } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { LayoutGroup, motion } from "motion/react";

import {
  COMPONENTS,
  buildCharacter,
  type CastCharacter,
  type HoverAnim,
} from "@/cast/cast-roster";
import { composeSvg } from "@/utils/avatar-svg-compositor";

/** A character already chosen, used to reopen the modal mid-flow (e.g. Back
 * from a later beat) instead of dropping the user back at the bare line-up. */
export interface StarterResume {
  bodyShape: string;
  eyeStyle: string;
  color: string;
  name: string;
}

const indexOfBody = (id: string) => Math.max(0, BODIES.findIndex((b) => b.id === id));
const indexOfEye = (id: string) => Math.max(0, EYES.findIndex((e) => e.id === id));
const indexOfColor = (id: string) => Math.max(0, COLORS.findIndex((c) => c.id === id));

const BODIES = COMPONENTS.bodyShapes;
const EYES = COMPONENTS.eyeStyles;
const COLORS = COMPONENTS.colors;

/** Friendly default expression the starter line-up wears. */
const DEFAULT_EYE_INDEX = Math.max(
  0,
  EYES.findIndex((e) => e.id === "curious"),
);

/** Signature hover move per starter, so each shape previews a bit of life. */
const STARTER_HOVERS: HoverAnim[] = ["jump", "wiggle", "flip", "spin"];

/** Grid width — must match the CSS `repeat(5, …)` so the neighbour-aware color
 * assignment below knows which cards are adjacent (incl. diagonals). */
const ROSTER_COLS = 5;

/** Deterministic, well-mixed hash (no Math.random in Cast). */
function hash(n: number): number {
  let v = Math.imul(n ^ 0x9e3779b1, 2654435761);
  v ^= v >>> 15;
  v = Math.imul(v, 0x85ebca6b);
  v ^= v >>> 13;
  return v >>> 0;
}

/**
 * A scattered color per starter. A color linear in the index repeats on the
 * down-right diagonal (neighbour `i + COLS + 1`, and 6 colors divide evenly
 * into that stride), so instead we hash each index and nudge it off conflicts.
 *
 * Two tiers: a *hard* set (left / up / up-left / up-right neighbours) that must
 * never match, and a *soft* set (every color already used in this row) we try
 * to avoid so rows read as distinct. When the soft set leaves nothing free we
 * fall back to the hard set only — that yields at most one (non-adjacent)
 * repeated color per row, which is acceptable here.
 */
const STARTER_COLOR_INDEX: number[] = (() => {
  const out: number[] = [];
  for (let i = 0; i < BODIES.length; i++) {
    const col = i % ROSTER_COLS;
    const hard = new Set<number>();
    if (col > 0) hard.add(out[i - 1]); // left
    if (i - ROSTER_COLS >= 0) hard.add(out[i - ROSTER_COLS]); // up
    if (col > 0 && i - ROSTER_COLS - 1 >= 0) hard.add(out[i - ROSTER_COLS - 1]); // up-left
    if (col < ROSTER_COLS - 1 && i - ROSTER_COLS + 1 >= 0) hard.add(out[i - ROSTER_COLS + 1]); // up-right

    const soft = new Set(hard);
    for (let j = i - col; j < i; j++) soft.add(out[j]); // colors already in this row

    const start = hash(i) % COLORS.length;
    const pick = (avoid: Set<number>): number | null => {
      for (let k = 0; k < COLORS.length; k++) {
        const c = (start + k) % COLORS.length;
        if (!avoid.has(c)) return c;
      }
      return null;
    };

    out.push(pick(soft) ?? pick(hard) ?? start);
  }
  return out;
})();

function cycle(i: number, n: number, dir: 1 | -1): number {
  return (i + dir + n) % n;
}

export function CastStarter({
  resume,
  onChoose,
}: {
  resume?: StarterResume | null;
  onChoose: (character: CastCharacter, name: string) => void;
}) {
  // null → roster line-up; a body index → customizing that starter. `resume`
  // (set when returning from a later beat) reopens straight into the card.
  const [bodyIndex, setBodyIndex] = useState<number | null>(
    resume ? indexOfBody(resume.bodyShape) : null,
  );
  const [eyeIndex, setEyeIndex] = useState(
    resume ? indexOfEye(resume.eyeStyle) : DEFAULT_EYE_INDEX,
  );
  const [colorIndex, setColorIndex] = useState(
    resume ? indexOfColor(resume.color) : 0,
  );
  // The shape that was tapped, held stable for the whole customization so the
  // shared-layout morph (and its reverse, on Back) stays anchored to one card.
  const [pickedId, setPickedId] = useState<string | null>(resume?.bodyShape ?? null);
  // The assistant's name — editable right here in the card, defaulted from the
  // shape's stock name on first pick and kept across body/eyes/color tweaks.
  const [name, setName] = useState(resume?.name ?? "");

  const pickStarter = useCallback((i: number) => {
    setBodyIndex(i);
    setPickedId(BODIES[i].id);
    setEyeIndex(DEFAULT_EYE_INDEX);
    // Carry over the color shown on the tapped card so the preview matches it.
    setColorIndex(STARTER_COLOR_INDEX[i]);
    setName(buildCharacter(BODIES[i].id, EYES[DEFAULT_EYE_INDEX].id, COLORS[STARTER_COLOR_INDEX[i]].id).name);
  }, []);

  const handleRandomize = useCallback(() => {
    // Walk each axis a deterministic, well-mixed step — no Math.random in Cast.
    setBodyIndex((b) => ((b ?? 0) + 3) % BODIES.length);
    setEyeIndex((e) => (e + 4) % EYES.length);
    setColorIndex((c) => (c + 5) % COLORS.length);
  }, []);

  const handleContinue = useCallback(() => {
    if (bodyIndex === null) return;
    const character = buildCharacter(
      BODIES[bodyIndex].id,
      EYES[eyeIndex].id,
      COLORS[colorIndex].id,
    );
    onChoose(character, name.trim() || character.name);
  }, [bodyIndex, eyeIndex, colorIndex, name, onChoose]);

  const previewSvg = useMemo(() => {
    if (bodyIndex === null) return "";
    return composeSvg(
      COMPONENTS,
      BODIES[bodyIndex].id,
      EYES[eyeIndex].id,
      COLORS[colorIndex].id,
      280,
    );
  }, [bodyIndex, eyeIndex, colorIndex]);

  // The pedestal whose avatar has been lifted into the open card (empty slot).
  const activePickId = bodyIndex !== null ? pickedId : null;

  return (
    <div className="cast-starter">
      {/* one LayoutGroup so the tapped avatar morphs between line-up and card */}
      <LayoutGroup>
        {/* line-up stays mounted underneath — the card sits atop it */}
        <div className="cast-starter__view">
          <header className="cast-starter__header">
            <h1 className="cast-panel__title">Choose your assistant</h1>
            <p className="cast-panel__subtitle">Pick one, then make it yours.</p>
          </header>

          <div className="cast-roster">
            {BODIES.map((body, i) => (
              <StarterCard
                key={body.id}
                index={i}
                bodyId={body.id}
                colorId={COLORS[STARTER_COLOR_INDEX[i]].id}
                picked={activePickId === body.id}
                onPick={pickStarter}
              />
            ))}
          </div>
        </div>

        {bodyIndex !== null && (
          <div className="cast-customize__layer">
            <motion.div
              className="cast-customize__scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              onClick={() => setBodyIndex(null)}
            />
            <motion.div
              className="cast-customize"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <button
                className="cast-customize__back"
                onClick={() => setBodyIndex(null)}
                aria-label="Back to the line-up"
              >
                ‹
              </button>

              <div className="cast-customize__stage">
                <div className="cast-customize__disc" />
                <motion.div
                  layoutId={pickedId ? `starter-${pickedId}` : undefined}
                  className="cast-customize__avatar"
                  aria-hidden
                  dangerouslySetInnerHTML={{ __html: previewSvg }}
                />
              </div>

              <NameField value={name} onChange={setName} />

              <div className="cast-controls">
                <CycleRow
                  label="Body"
                  value={BODIES[bodyIndex].id}
                  onPrev={() => setBodyIndex(cycle(bodyIndex, BODIES.length, -1))}
                  onNext={() => setBodyIndex(cycle(bodyIndex, BODIES.length, 1))}
                />
                <CycleRow
                  label="Eyes"
                  value={EYES[eyeIndex].id}
                  onPrev={() => setEyeIndex(cycle(eyeIndex, EYES.length, -1))}
                  onNext={() => setEyeIndex(cycle(eyeIndex, EYES.length, 1))}
                />
                <CycleRow
                  label="Color"
                  value={COLORS[colorIndex].id}
                  swatch={COLORS[colorIndex].hex}
                  onPrev={() => setColorIndex(cycle(colorIndex, COLORS.length, -1))}
                  onNext={() => setColorIndex(cycle(colorIndex, COLORS.length, 1))}
                />
              </div>

              <div className="cast-customize__actions">
                <button
                  type="button"
                  className="cast-randomize"
                  onClick={handleRandomize}
                  aria-label="Randomize"
                >
                  <Dices className="cast-randomize__icon" />
                  Randomize
                </button>
                <button
                  type="button"
                  className="cast-customize__continue"
                  onClick={handleContinue}
                >
                  Continue
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </LayoutGroup>
    </div>
  );
}

/* ---------------- roster card ---------------- */

const StarterCard = memo(function StarterCard({
  index,
  bodyId,
  colorId,
  picked,
  onPick,
}: {
  index: number;
  bodyId: string;
  colorId: string;
  picked: boolean;
  onPick: (index: number) => void;
}) {
  const svg = useMemo(
    () => composeSvg(COMPONENTS, bodyId, EYES[DEFAULT_EYE_INDEX].id, colorId, 240),
    [bodyId, colorId],
  );
  return (
    <button
      type="button"
      className="cast-roster__card"
      aria-label={`Choose the ${bodyId} shape`}
      onClick={() => onPick(index)}
    >
      <span className="cast-roster__disc" />
      {picked ? (
        // avatar has been lifted into the open card — leave the pedestal bare
        <span className="cast-roster__avatar" aria-hidden />
      ) : (
        // shared layoutId → this avatar is what morphs into the modal preview
        <motion.span layoutId={`starter-${bodyId}`} className="cast-roster__avatar">
          <span
            className="cast-hover"
            data-anim={STARTER_HOVERS[index % STARTER_HOVERS.length]}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </motion.span>
      )}
    </button>
  );
});

/* ---------------- inline name editor ---------------- */

function NameField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <input
        className="cast-customize__name-input"
        autoFocus
        defaultValue={value}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v) onChange(v);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="cast-customize__name"
      onClick={() => setEditing(true)}
      aria-label={`Rename ${value}`}
    >
      <span className="cast-customize__name-text">{value}</span>
      <Pencil className="cast-customize__name-pencil" />
    </button>
  );
}

/* ---------------- cycle control (mirrors the avatar-modal control) ---------- */

function CycleRow({
  label,
  value,
  swatch,
  onPrev,
  onNext,
}: {
  label: string;
  value: string;
  swatch?: string;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="cast-control">
      <span className="cast-control__label">{label}</span>
      <div className="cast-control__cycle">
        <button
          type="button"
          className="cast-control__btn"
          onClick={onPrev}
          aria-label={`Previous ${label.toLowerCase()}`}
        >
          <ChevronLeft className="cast-control__chev" />
        </button>
        <span className="cast-control__value">
          {swatch && <span className="cast-control__swatch" style={{ background: swatch }} />}
          {value}
        </span>
        <button
          type="button"
          className="cast-control__btn"
          onClick={onNext}
          aria-label={`Next ${label.toLowerCase()}`}
        >
          <ChevronRight className="cast-control__chev" />
        </button>
      </div>
    </div>
  );
}
