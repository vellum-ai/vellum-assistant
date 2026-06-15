/**
 * Cast — starter selection (replaces the spotlight crowd as Beat 1).
 *
 * Fighting-game-style character select: a large spotlight panel centered on
 * screen shows the currently highlighted character (BlinkingAvatar, 280 px).
 * A 3D carousel below the avatar lets users cycle through eye styles, and a
 * floating thumbnail tray at the bottom selects the body shape. Clicking the
 * spotlight opens the customization card (color / name). A shared `layoutId`
 * morphs the spotlight avatar into the customization preview.
 */

import { ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutGroup, motion } from "motion/react";

import { BlinkingAvatar } from "@/cast/cast-avatar";
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
const _indexOfEye = (id: string) => Math.max(0, EYES.findIndex((e) => e.id === id));
const _indexOfColor = (id: string) => Math.max(0, COLORS.findIndex((c) => c.id === id));

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

/**
 * Pre-computed character combos — 16 total. First pass: one per body (10),
 * each with a deterministically shuffled eye+color. Second pass: 6 more bodies
 * with a different eye+color seed so every combo is visually distinct.
 */
const STARTER_COMBOS: { bodyIndex: number; eyeIndex: number; colorIndex: number }[] = (() => {
  const out: { bodyIndex: number; eyeIndex: number; colorIndex: number }[] = [];
  // First pass: all 10 bodies
  for (let i = 0; i < BODIES.length; i++) {
    out.push({
      bodyIndex: i,
      eyeIndex: hash(i * 7 + 3) % EYES.length,
      colorIndex: STARTER_COLOR_INDEX[i],
    });
  }
  // Second pass: 6 more with shifted eye + color so they look different
  for (let j = 0; j < 6; j++) {
    const bi = hash(j * 13 + 47) % BODIES.length;
    out.push({
      bodyIndex: bi,
      eyeIndex: hash(j * 11 + 59) % EYES.length,
      colorIndex: (STARTER_COLOR_INDEX[bi] + j + 2) % COLORS.length,
    });
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
  embedded,
}: {
  resume?: StarterResume | null;
  onChoose: (character: CastCharacter, name: string) => void;
  onCustomizing?: (active: boolean) => void;
  embedded?: boolean;
}) {
  // Which character is highlighted in the spotlight — random start unless resuming.
  const [selectedIndex, setSelectedIndex] = useState(
    () => resume ? indexOfBody(resume.bodyShape) : hash(Date.now()) % STARTER_COMBOS.length,
  );
  // The shape that was tapped, held stable for the whole customization so the
  // shared-layout morph (and its reverse, on Back) stays anchored to one card.
  const [_pickedId, _setPickedId] = useState<string | null>(resume?.bodyShape ?? null);
  // The assistant's name — editable on the select screen and in the card,
  // defaulted from the shape's stock name and kept across body/eyes/color tweaks.
  const defaultName = useCallback((i: number) => {
    const combo = STARTER_COMBOS[i];
    return buildCharacter(BODIES[combo.bodyIndex].id, EYES[combo.eyeIndex].id, COLORS[combo.colorIndex].id).name;
  }, []);
  const [name, setName] = useState(resume?.name ?? defaultName(selectedIndex));

  // Sync name when cycling through the carousel.
  const prevSelected = useRef(selectedIndex);
  useEffect(() => {
    if (prevSelected.current !== selectedIndex) {
      prevSelected.current = selectedIndex;
      setName(defaultName(selectedIndex));
    }
  }, [selectedIndex, defaultName]);

  const _pickStarter = useCallback((i: number) => {
    _setPickedId(BODIES[i].id);
    onCustomizing?.(true);
  }, [onCustomizing]);

  const handleContinue = useCallback(() => {
    const combo = STARTER_COMBOS[selectedIndex];
    const character = buildCharacter(
      BODIES[combo.bodyIndex].id,
      EYES[combo.eyeIndex].id,
      COLORS[combo.colorIndex].id,
    );
    onChoose(character, name.trim() || character.name);
  }, [selectedIndex, name, onChoose]);

  // A counter that increments on every attribute change, used to trigger a pop.
  const changeCount = useRef(0);
  const [_popKey, setPopKey] = useState(0);
  const prevIdx = useRef(selectedIndex);

  useEffect(() => {
    if (prevIdx.current !== selectedIndex) {
      changeCount.current += 1;
      setPopKey(changeCount.current);
      prevIdx.current = selectedIndex;
    }
  }, [selectedIndex]);

  // Render full-character SVG thumbnails for the 3D carousel.
  const comboPreviews = useMemo(
    () => STARTER_COMBOS.map((combo) =>
      composeSvg(COMPONENTS, BODIES[combo.bodyIndex].id, EYES[combo.eyeIndex].id, COLORS[combo.colorIndex].id, 141),
    ),
    [],
  );
  const carouselAngle = 360 / STARTER_COMBOS.length;
  const carouselRadius = Math.round(158 / (2 * Math.tan(Math.PI / STARTER_COMBOS.length)));

  // Track continuous rotation so wrapping around feels like an infinite scroll
  // instead of snapping backwards.
  const [rotation, setRotation] = useState(-selectedIndex * carouselAngle);
  const rotationSelectedRef = useRef(selectedIndex);

  useEffect(() => {
    const prev = rotationSelectedRef.current;
    if (prev === selectedIndex) return;
    const n = STARTER_COMBOS.length;
    // Compute the shortest angular step (handles wrap-around)
    let diff = selectedIndex - prev;
    if (diff > n / 2) diff -= n;
    if (diff < -n / 2) diff += n;
    setRotation((r) => r - diff * carouselAngle);
    rotationSelectedRef.current = selectedIndex;
  }, [selectedIndex, carouselAngle]);

  const starterCls = embedded ? "cast-starter cast-starter--embedded" : "cast-starter";
  const selectCls = embedded ? "cast-select cast-select--embedded" : "cast-select";

  const content = (
    <div className={starterCls}>
      {/* one LayoutGroup so the spotlight avatar morphs into the customization card */}
      <LayoutGroup>
        {/* centered spotlight with floating header + thumbnail tray */}
        <div className={selectCls}>
          <header className="cast-select__header">
            <h1 className="cast-panel__title">Give me a face and a name</h1>
          </header>

          <div className="cast-select__spotlight">
            {/* 3D character carousel — scroll to select */}
            <div role="presentation" className="cast-select__eye-carousel" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="cast-select__eye-btn"
                onClick={() => setSelectedIndex(cycle(selectedIndex, STARTER_COMBOS.length, -1))}
                aria-label="Previous character"
              >
                <ChevronLeft />
              </button>
              <div className="cast-select__eye-stage">
                <div
                  className="cast-select__eye-ring"
                  style={{ transform: `rotateY(${rotation}deg)` }}
                >
                  {STARTER_COMBOS.map((combo, i) => (
                    <button
                      key={`${BODIES[combo.bodyIndex].id}-${i}`}
                      type="button"
                      className={`cast-select__eye-item${i === selectedIndex ? " cast-select__eye-item--active" : ""}`}
                      style={{ transform: `rotateY(${i * carouselAngle}deg) translateZ(${carouselRadius}px)` }}
                      onClick={() => setSelectedIndex(i)}
                      aria-label={`${BODIES[combo.bodyIndex].id} character`}
                    >
                      {i === selectedIndex ? (
                        <span
                          key={`active-${selectedIndex}`}
                          className="cast-select__eye-personality"
                          data-anim={STARTER_HOVERS[i % STARTER_HOVERS.length]}
                        >
                          <BlinkingAvatar
                            bodyShapeId={BODIES[combo.bodyIndex].id}
                            eyeStyleId={EYES[combo.eyeIndex].id}
                            colorId={COLORS[combo.colorIndex].id}
                            size={141}
                          />
                        </span>
                      ) : (
                        <span dangerouslySetInnerHTML={{ __html: comboPreviews[i] }} />
                      )}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="cast-select__eye-btn"
                onClick={() => setSelectedIndex(cycle(selectedIndex, STARTER_COMBOS.length, 1))}
                aria-label="Next character"
              >
                <ChevronRight />
              </button>
            </div>

            {/* spotlight glow beneath the carousel */}
            <div className="cast-select__carousel-glow" />

            <div role="presentation" className="cast-select__name" onClick={(e) => e.stopPropagation()}>
              <input
                className="cast-select__name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                size={Math.max(1, name.length)}
                aria-label="Assistant name"
              />
            </div>

            <button
              type="button"
              className="cast-vn__advance"
              onClick={handleContinue}
            >
              Next &#9660;
            </button>
          </div>

        </div>

      </LayoutGroup>
    </div>
  );

  if (embedded) {
    return (
      <motion.div
        key="starter"
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -40 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        style={{ width: "100%", height: "100%" }}
      >
        {content}
      </motion.div>
    );
  }

  return content;
}

/* ---------------- roster card (kept for reference) ---------------- */

const _StarterCard = memo(function StarterCard({
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

/* ---------------- thumbnail (compact grid item) ---------------- */

const _Thumbnail = memo(function Thumbnail({
  index,
  bodyId,
  colorId,
  colorHex,
  active,
  onSelect,
}: {
  index: number;
  bodyId: string;
  colorId: string;
  colorHex: string;
  active: boolean;
  onSelect: (index: number) => void;
}) {
  const svg = useMemo(
    () => composeSvg(COMPONENTS, bodyId, EYES[DEFAULT_EYE_INDEX].id, colorId, 120),
    [bodyId, colorId],
  );
  return (
    <button
      type="button"
      className={`cast-select__thumb${active ? " cast-select__thumb--active" : ""}`}
      style={{ color: colorHex }}
      aria-label={`Select the ${bodyId} shape`}
      onClick={() => onSelect(index)}
    >
      <span dangerouslySetInnerHTML={{ __html: svg }} />
    </button>
  );
});

/* ---------------- inline name editor ---------------- */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

function _CycleRow({
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
          {!swatch && value}
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
