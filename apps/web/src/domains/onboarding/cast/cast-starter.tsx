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
 *
 * Ported from the prototype's `apps/web/src/cast/cast-starter.tsx` (18c4451).
 * The prototype's `BlinkingAvatar` accepted per-axis ids + a `size`; here we
 * reuse the already-ported `cast-shell` `BlinkingAvatar`, which takes a
 * `CastCharacter`. The compositor renders into a fixed coordinate space that
 * CSS scales to 100% of the avatar box (`.cast-avatar svg`), so the dropped
 * `size` prop is purely cosmetic and the rendered art is identical.
 */

import { Button, Input } from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";
import { ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutGroup, motion } from "motion/react";

import {
  COMPONENTS,
  buildCharacter,
  hash,
  type CastCharacter,
  type HoverAnim,
} from "@/domains/onboarding/cast/cast-roster";
import { BlinkingAvatar } from "@/domains/onboarding/cast/cast-shell";
import type { StarterResume } from "@/domains/onboarding/cast/screens/screen-slot";
import { composeSvg } from "@/utils/avatar-svg-compositor";

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

    const start = hash(i, 1) % COLORS.length;
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
  onCustomizing,
}: {
  resume?: StarterResume | null;
  onChoose: (character: CastCharacter, name: string) => void;
  onCustomizing?: (active: boolean) => void;
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
    onCustomizing?.(true);
  }, [onCustomizing]);

  const handleContinue = useCallback(() => {
    if (bodyIndex === null) return;
    const character = buildCharacter(
      BODIES[bodyIndex].id,
      EYES[eyeIndex].id,
      COLORS[colorIndex].id,
    );
    onChoose(character, name.trim() || character.name);
  }, [bodyIndex, eyeIndex, colorIndex, name, onChoose]);

  // A counter that increments on every attribute change, used to trigger a pop.
  const changeCount = useRef(0);
  const [popKey, setPopKey] = useState(0);
  const prevBody = useRef(bodyIndex);
  const prevEye = useRef(eyeIndex);
  const prevColor = useRef(colorIndex);

  useEffect(() => {
    if (
      prevBody.current !== bodyIndex ||
      prevEye.current !== eyeIndex ||
      prevColor.current !== colorIndex
    ) {
      changeCount.current += 1;
      setPopKey(changeCount.current);
      prevBody.current = bodyIndex;
      prevEye.current = eyeIndex;
      prevColor.current = colorIndex;
    }
  }, [bodyIndex, eyeIndex, colorIndex]);

  // The live preview character, rebuilt whenever any axis changes. The shell's
  // `BlinkingAvatar` consumes a full `CastCharacter`; the prototype's variant
  // took the three ids directly. Building here keeps the same inputs.
  const previewCharacter = useMemo(
    () =>
      bodyIndex === null
        ? null
        : buildCharacter(BODIES[bodyIndex].id, EYES[eyeIndex].id, COLORS[colorIndex].id),
    [bodyIndex, eyeIndex, colorIndex],
  );

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
            <p className="cast-panel__subtitle">You can always change this later.</p>
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

        {bodyIndex !== null && previewCharacter && (
          <motion.div
            className="absolute inset-0 z-[6] flex h-[100dvh] flex-col items-center justify-center px-5 [background:radial-gradient(120%_90%_at_50%_0%,var(--surface-lift)_0%,var(--surface-base)_60%,var(--cast-shroud)_100%)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            <Button
              variant="ghost"
              iconOnly={<ChevronLeft />}
              expandOnMobile={false}
              onClick={() => { setBodyIndex(null); onCustomizing?.(false); }}
              aria-label="Back to the line-up"
              className="absolute left-8 top-9 z-[5] rounded-full bg-[var(--surface-hover)] hover:bg-[var(--surface-active)]"
            />

            <NameField value={name} onChange={setName} />

            <div className="mb-14 mt-6 h-[140px] w-[140px]">
              <motion.div
                key={popKey}
                layoutId={pickedId ? `starter-${pickedId}` : undefined}
                className="h-full w-full"
                initial={popKey > 0 ? { scale: 1.12 } : false}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 400, damping: 15 }}
              >
                <BlinkingAvatar character={previewCharacter} />
              </motion.div>
            </div>

            <div className="cast-thisthat">
              <div className="cast-thisthat__row">
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
              <Button
                variant="ghost"
                fullWidth
                onClick={handleContinue}
                className="mt-3.5 h-auto py-3 text-[15px] font-semibold text-[var(--content-secondary)] hover:text-[var(--content-default)]"
              >
                That&apos;s me &rarr;
              </Button>
            </div>
          </motion.div>
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
      <Input
        autoFocus
        defaultValue={value}
        aria-label="Assistant name"
        wrapperClassName="w-auto self-center"
        className={cn(
          "h-auto w-auto min-w-[80px] max-w-[200px] rounded-none border-0 border-b-2 bg-transparent",
          "border-[var(--border-element)] px-2.5 py-1 text-center text-[22px] font-[660] tracking-[-0.01em]",
          "text-[var(--content-default)] focus-visible:border-[var(--content-default)]",
        )}
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
    <Button
      variant="ghost"
      rightIcon={<Pencil className="h-[15px] w-[15px] opacity-50 transition-opacity group-hover/name:opacity-95" />}
      onClick={() => setEditing(true)}
      aria-label={`Rename ${value}`}
      className="group/name h-auto self-center gap-2 px-1.5 py-0.5 text-[22px] font-[660] tracking-[-0.01em] text-[var(--content-default)] hover:bg-transparent"
    >
      <span className="underline decoration-transparent decoration-2 underline-offset-4 transition-[text-decoration-color] group-hover/name:decoration-[var(--content-secondary)]">
        {value}
      </span>
    </Button>
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
    <div className="flex min-h-[132px] flex-1 flex-col items-center justify-center gap-2.5 rounded-[var(--radius-xl)] border border-[var(--border-base)] p-5">
      <span className="text-center text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--content-tertiary)]">
        {label}
      </span>
      <div className="flex items-center justify-center gap-2.5">
        <Button
          variant="ghost"
          iconOnly={<ChevronLeft />}
          expandOnMobile={false}
          onClick={onPrev}
          aria-label={`Previous ${label.toLowerCase()}`}
        />
        <span className="inline-flex min-w-[96px] items-center justify-center gap-2 text-[22px] font-[640] capitalize text-[var(--content-default)]">
          {swatch ? (
            <span
              className="h-[15px] w-[15px] rounded-full border border-[var(--border-element)]"
              style={{ background: swatch }}
            />
          ) : (
            value
          )}
        </span>
        <Button
          variant="ghost"
          iconOnly={<ChevronRight />}
          expandOnMobile={false}
          onClick={onNext}
          aria-label={`Next ${label.toLowerCase()}`}
        />
      </div>
    </div>
  );
}
