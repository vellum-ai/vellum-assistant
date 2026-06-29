/**
 * "Give me a face and a name" — pick an avatar for the assistant and name it.
 *
 * SPIKE — research-onboarding flow.
 *
 * Second step of the research onboarding (after the details form). Cycles
 * through the shared random character pool: the selected character sits in the
 * center, the rest peek in, cut off, from the edges. The left/right arrows swap
 * the neighbouring character into the center (it springs in and bounces) while
 * the previously-centered one flies back out to the vacated edge slot — all
 * driven by `OnboardingCharacterStage`.
 *
 * Presentational: owns the carousel arrangement + name, and reports the chosen
 * character + name up via `onContinue`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Dices, Pencil } from "lucide-react";

import { OnboardingCharacterStage } from "@/domains/onboarding/components/onboarding-character-stage";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import {
  OnboardingStageSizeProvider,
  useElementSize,
} from "@/domains/onboarding/hooks/use-onboarding-stage-size";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import type { CharacterTraits } from "@/types/avatar";
import { Button } from "@vellumai/design-library/components/button";

export interface GiveMeAFaceValues {
  traits: CharacterTraits;
  name: string;
}

interface GiveMeAFaceScreenProps {
  onContinue: (values: GiveMeAFaceValues) => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}

/** Prefill names, cycled across the pool and swapped in as you change avatars. */
const ASSISTANT_NAMES = ["Ziggy", "Quill", "Luna", "Remy", "Cleo", "Cade"];

/** The carousel arrangement: who's centered + who sits in each edge slot. */
interface Arrangement {
  centerChar: number;
  edgeOrder: number[];
}

function initialArrangement(count: number, centerChar: number): Arrangement {
  const edgeOrder: number[] = [];
  for (let i = 0; i < count; i++) {
    if (i !== centerChar) edgeOrder.push(i);
  }
  return { centerChar, edgeOrder };
}

export function GiveMeAFaceScreen({
  onContinue,
  onBack,
  onForward,
}: GiveMeAFaceScreenProps) {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const ensureGenerated = useOnboardingAvatarPoolStore.use.ensureGenerated();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const setSelectedIndex = useOnboardingAvatarPoolStore.use.setSelectedIndex();

  useEffect(() => {
    if (components) ensureGenerated(components);
  }, [components, ensureGenerated]);

  const count = characters.length;
  const [arrangement, setArrangement] = useState<Arrangement | null>(null);
  const [name, setName] = useState("");
  const [editingName, setEditingName] = useState(false);
  // Once the user edits the name, stop prefilling it from the avatar's default
  // so their custom name survives cycling through avatars.
  const nameCustomized = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Measure this screen's container so the decorative stage shares the exact
  // coordinate space as the foreground arrows/title/buttons (see
  // use-onboarding-stage-size).
  const { ref: stageRef, size: stageSize } = useElementSize();
  // The current swap: the newly selected char + the slot it came from
  // (entering), and the old center + the slot it's heading to (exiting).
  const [swap, setSwap] = useState<{
    entering: { char: number; fromSlot: number };
    exiting: { char: number; toSlot: number };
  } | null>(null);

  // Seed the arrangement once the pool exists, centering the stored selection.
  useEffect(() => {
    if (count > 0 && arrangement === null) {
      setArrangement(initialArrangement(count, selectedIndex));
    }
  }, [count, selectedIndex, arrangement]);

  // Keep the store's selection in sync so the chosen avatar survives navigation.
  useEffect(() => {
    if (arrangement) setSelectedIndex(arrangement.centerChar);
  }, [arrangement, setSelectedIndex]);

  // Prefill the name for the centered avatar, swapping it as you cycle — but
  // never clobber a name the user has typed.
  const centerChar = arrangement?.centerChar;
  useEffect(() => {
    if (centerChar != null && !nameCustomized.current) {
      setName(ASSISTANT_NAMES[centerChar % ASSISTANT_NAMES.length]!);
    }
  }, [centerChar]);

  // Focus (and select) the field when entering edit mode.
  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [editingName]);

  // Swap `targetChar` into the center; the old center takes its vacated slot.
  // The incoming avatar flies off-screen then pops into the center; the old
  // center shrinks away then reappears at `slot` (both tracked via `swap`).
  function moveTo(targetChar: number) {
    if (!arrangement || targetChar === arrangement.centerChar) return;
    const slot = arrangement.edgeOrder.indexOf(targetChar);
    if (slot < 0) return;
    const edgeOrder = [...arrangement.edgeOrder];
    edgeOrder[slot] = arrangement.centerChar;
    setSwap({
      entering: { char: targetChar, fromSlot: slot },
      exiting: { char: arrangement.centerChar, toSlot: slot },
    });
    setArrangement({ centerChar: targetChar, edgeOrder });
  }

  const goNext = () =>
    arrangement && moveTo((arrangement.centerChar + 1) % count);
  const goPrev = () =>
    arrangement && moveTo((arrangement.centerChar - 1 + count) % count);

  const centeredTraits = useMemo(
    () => (arrangement ? characters[arrangement.centerChar] : undefined),
    [arrangement, characters],
  );

  const ready = !!components && !!arrangement && !!centeredTraits;

  function handleContinue() {
    if (centeredTraits) onContinue({ traits: centeredTraits, name: name.trim() });
  }

  // Roll a random name from the pool (different from the current one). Counts as
  // a deliberate pick, so — like editing — it sticks across avatar cycling
  // instead of being re-prefilled from the centered avatar.
  function randomizeName() {
    nameCustomized.current = true;
    setName((current) => {
      const options = ASSISTANT_NAMES.filter((candidate) => candidate !== current);
      const pool = options.length > 0 ? options : ASSISTANT_NAMES;
      return pool[Math.floor(Math.random() * pool.length)]!;
    });
  }

  const arrowClass =
    "pointer-events-auto z-10 flex cursor-pointer h-10 w-10 items-center justify-center rounded-full " +
    "bg-[color-mix(in_srgb,var(--content-default)_10%,transparent)] text-[var(--content-default)] " +
    "transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--content-default)_18%,transparent)]";

  return (
    <div
      ref={stageRef}
      data-theme="dark"
      className="relative h-full overflow-hidden bg-[var(--surface-base)] text-[var(--content-default)]"
    >
      <OnboardingStageSizeProvider size={stageSize}>
      {ready && (
        <OnboardingCharacterStage
          components={components}
          characters={characters}
          centerChar={arrangement.centerChar}
          edgeOrder={arrangement.edgeOrder}
          entering={swap?.entering ?? null}
          exiting={swap?.exiting ?? null}
          onEnterComplete={(char) =>
            setSwap((curr) => (curr?.entering.char === char ? null : curr))
          }
          onSelectChar={moveTo}
        />
      )}

      {/* Redo routes through Continue (not the generic step redo) so any avatar
          or name edits made after stepping back are captured before advancing —
          otherwise the redo would re-stage the previous selection. */}
      <OnboardingTopBar
        tone="light"
        onBack={onBack}
        onNext={onForward ? handleContinue : undefined}
      />

      {/* Title */}
      <h1
        className="absolute left-1/2 top-[19%] z-10 -translate-x-1/2 whitespace-nowrap text-center text-[2.6rem] leading-none"
        style={{
          fontFamily: "var(--font-serif)",
          animation: "fadeInUp 0.4s ease-out both",
        }}
      >
        Give me a face and a name
      </h1>

      {/* Cycle arrows, flanking the centered avatar */}
      <button
        type="button"
        aria-label="Previous character"
        onClick={goPrev}
        className={`absolute left-[calc(50%-170px)] top-[40%] -translate-y-1/2 ${arrowClass}`}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Next character"
        onClick={goNext}
        className={`absolute right-[calc(50%-170px)] top-[40%] -translate-y-1/2 ${arrowClass}`}
      >
        <ArrowRight className="h-4 w-4" />
      </button>

      {/* Name (view ↔ edit) + Continue, grouped with room between them. */}
      <div className="absolute left-1/2 top-[51%] z-10 flex -translate-x-1/2 flex-col items-center gap-12">
        {editingName ? (
          <input
            ref={nameInputRef}
            value={name}
            onChange={(e) => {
              nameCustomized.current = true;
              setName(e.target.value);
            }}
            onBlur={() => setEditingName(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setEditingName(false);
              }
            }}
            placeholder="Name your assistant"
            aria-label="Assistant name"
            className="w-[234px] rounded-2xl border border-[var(--border-element)] bg-transparent px-4 py-2.5 text-center text-lg text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none transition-colors duration-150 focus:border-[var(--border-active)]"
          />
        ) : (
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setEditingName(true)}
              aria-label="Edit name"
              className="flex cursor-pointer items-center gap-2.5"
            >
              <span
                className={`text-3xl font-medium ${name ? "text-[var(--content-default)]" : "text-[var(--content-tertiary)]"}`}
              >
                {name || "Name your assistant"}
              </span>
              <Pencil className="h-5 w-5 text-[var(--content-tertiary)]" />
            </button>
            <button
              type="button"
              onClick={randomizeName}
              aria-label="Shuffle name"
              title="Shuffle name"
              className="cursor-pointer text-[var(--content-tertiary)] transition-[transform,color] duration-300 hover:rotate-180 hover:text-[var(--content-default)]"
            >
              <Dices className="h-5 w-5" />
            </button>
          </div>
        )}

        <Button
          type="button"
          variant="primary"
          size="regular"
          rightIcon={<ArrowRight size={16} />}
          disabled={!ready}
          onClick={handleContinue}
          className="h-11 w-[234px] text-base"
        >
          Continue
        </Button>
      </div>
      </OnboardingStageSizeProvider>
    </div>
  );
}
