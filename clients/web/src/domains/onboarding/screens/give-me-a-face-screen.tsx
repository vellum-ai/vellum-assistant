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
import {
  ArrowLeft,
  ArrowRight,
  Dices,
  Loader2,
  Pencil,
  Square,
  Volume2,
} from "lucide-react";

import { useVoiceSamplePreview } from "@/components/speech/use-voice-sample-preview";
import { OnboardingCharacterStage } from "@/domains/onboarding/components/onboarding-character-stage";
import { OnboardingStage } from "@/domains/onboarding/components/onboarding-stage";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { resolveAvatarVoice } from "@/domains/onboarding/onboarding-avatar-voices";
import { useUnscopedManagedVoices } from "@/lib/tts/use-managed-voices";
import { randomCharacterTraits } from "@/utils/avatar-random";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import type { CharacterTraits } from "@/types/avatar";
import { Button } from "@vellumai/design-library/components/button";

export interface GiveMeAFaceValues {
  traits: CharacterTraits;
  name: string;
  /**
   * The managed voice belonging to the chosen avatar: what the user auditioned,
   * so the assistant has to speak in it. Null when the catalog never loaded, in
   * which case the assistant keeps the platform default.
   */
  voiceModel: string | null;
}

interface GiveMeAFaceScreenProps {
  onContinue: (values: GiveMeAFaceValues) => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
  /**
   * Whether to offer the voice audition. False for onboarding flows that adopt
   * a locally-hosted assistant: those can hold no platform session, so the
   * voice catalog is unreachable and the control could only ever sit inert.
   */
  canAuditionVoice?: boolean;
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
    if (i !== centerChar) {
      edgeOrder.push(i);
    }
  }
  return { centerChar, edgeOrder };
}

export function GiveMeAFaceScreen({
  onContinue,
  onBack,
  onForward,
  canAuditionVoice = true,
}: GiveMeAFaceScreenProps) {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const ensureGenerated = useOnboardingAvatarPoolStore.use.ensureGenerated();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const setSelectedIndex = useOnboardingAvatarPoolStore.use.setSelectedIndex();
  const setCharacterTraits =
    useOnboardingAvatarPoolStore.use.setCharacterTraits();

  useEffect(() => {
    if (components) {
      ensureGenerated(components);
    }
  }, [components, ensureGenerated]);

  const count = characters.length;
  const [arrangement, setArrangement] = useState<Arrangement | null>(null);
  const [name, setName] = useState("");
  const [editingName, setEditingName] = useState(false);
  // Once the user edits the name, stop prefilling it from the avatar's default
  // so their custom name survives cycling through avatars.
  const nameCustomized = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
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
    if (arrangement) {
      setSelectedIndex(arrangement.centerChar);
    }
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

  // Each avatar has its own voice (see onboarding-avatar-voices), auditioned
  // from the catalog's hosted sample. Samples are static provider-side assets,
  // so an audition costs no synthesis and no credits. The catalog comes
  // straight from the platform, so the audition is live as soon as this step
  // is, independent of the assistant hatching in the background.
  const { voices, loading: voicesLoading } = useUnscopedManagedVoices({
    enabled: canAuditionVoice,
  });
  const centeredVoice = useMemo(
    () => (centerChar == null ? null : resolveAvatarVoice(centerChar, voices)),
    [centerChar, voices],
  );
  const {
    previewingModel,
    play: playVoice,
    stop: stopVoice,
  } = useVoiceSamplePreview();
  const auditioning =
    centeredVoice !== null && previewingModel === centeredVoice.model;
  // Disabled-and-still-coming, as opposed to disabled because the catalog
  // failed. Those want different affordances.
  const voicePending = !centeredVoice && voicesLoading;

  function toggleVoice() {
    if (!centeredVoice) {
      return;
    }
    if (auditioning) {
      stopVoice();
      return;
    }
    playVoice(centeredVoice);
  }

  // Swap `targetChar` into the center; the old center takes its vacated slot.
  // The incoming avatar flies off-screen then pops into the center; the old
  // center shrinks away then reappears at `slot` (both tracked via `swap`).
  function moveTo(targetChar: number) {
    if (!arrangement || targetChar === arrangement.centerChar) {
      return;
    }
    const slot = arrangement.edgeOrder.indexOf(targetChar);
    if (slot < 0) {
      return;
    }
    // The audition belongs to the avatar leaving the center; letting it run on
    // would pair a voice with a face it isn't.
    stopVoice();
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
    if (centeredTraits) {
      onContinue({
        traits: centeredTraits,
        name: name.trim(),
        voiceModel: centeredVoice?.model ?? null,
      });
    }
  }

  // Reroll both the name and the centered avatar's traits, each guaranteed to
  // differ from the current one. The name counts as a deliberate pick, so
  // (like editing) it sticks across avatar cycling instead of being
  // re-prefilled from the centered avatar.
  function randomizeCharacter() {
    nameCustomized.current = true;
    setName((current) => {
      const options = ASSISTANT_NAMES.filter(
        (candidate) => candidate !== current,
      );
      const pool = options.length > 0 ? options : ASSISTANT_NAMES;
      return pool[Math.floor(Math.random() * pool.length)]!;
    });
    if (components && arrangement && centeredTraits) {
      let traits = randomCharacterTraits(components);
      while (
        traits.bodyShape === centeredTraits.bodyShape &&
        traits.eyeStyle === centeredTraits.eyeStyle &&
        traits.color === centeredTraits.color
      ) {
        traits = randomCharacterTraits(components);
      }
      setCharacterTraits(arrangement.centerChar, traits);
    }
  }

  const arrowClass =
    "pointer-events-auto z-10 flex cursor-pointer h-10 w-10 items-center justify-center rounded-full " +
    "bg-[color-mix(in_srgb,var(--content-default)_10%,transparent)] text-[var(--content-default)] " +
    "transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--content-default)_18%,transparent)]";

  return (
    <OnboardingStage className="bg-[var(--surface-base)] text-[var(--content-default)]">
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
        className="absolute left-1/2 top-[22%] z-10 -translate-x-1/2 whitespace-nowrap text-center text-[2.6rem] leading-none max-md:w-[90vw] max-md:whitespace-normal max-md:text-[2.08rem]"
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
        className={`absolute left-[calc(50%-170px)] top-[43%] -translate-y-1/2 ${arrowClass}`}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Next character"
        onClick={goNext}
        className={`absolute right-[calc(50%-170px)] top-[43%] -translate-y-1/2 ${arrowClass}`}
      >
        <ArrowRight className="h-4 w-4" />
      </button>

      {/* Name (view ↔ edit) + Continue, grouped with room between them. */}
      <div className="absolute left-1/2 top-[58%] z-10 flex -translate-x-1/2 flex-col items-center gap-10 max-md:top-[54%]">
        <div className="flex flex-col items-center gap-4">
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
                  className={`text-2xl font-medium ${name ? "text-[var(--content-default)]" : "text-[var(--content-tertiary)]"}`}
                >
                  {name || "Name your assistant"}
                </span>
                <Pencil className="h-5 w-5 text-[var(--content-tertiary)]" />
              </button>
              <button
                type="button"
                onClick={randomizeCharacter}
                aria-label="Shuffle name and appearance"
                title="Shuffle name and appearance"
                className="cursor-pointer text-[var(--content-tertiary)] transition-[transform,color] duration-300 hover:rotate-180 hover:text-[var(--content-default)]"
              >
                <Dices className="h-5 w-5" />
              </button>
            </div>
          )}

          {/* The only place voice is surfaced in onboarding. It auditions the
                CENTERED avatar's own voice, so cycling the carousel is also how
                you shop for a voice. While the catalog is in flight the button
                spins rather than sitting dead: a slow fetch has to read as
                "coming", not "broken". Absent entirely where the catalog is out
                of reach, rather than offered and permanently inert. */}
          {canAuditionVoice && (
            <button
              type="button"
              onClick={toggleVoice}
              disabled={!centeredVoice}
              title="Hear my voice"
              aria-label={
                auditioning ? "Stop the voice sample" : "Hear my voice"
              }
              aria-busy={voicePending}
              className={`flex cursor-pointer items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--content-default)_22%,transparent)] px-4 py-2 text-sm text-[var(--content-default)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--content-default)_10%,transparent)] disabled:cursor-default ${voicePending ? "disabled:opacity-70" : "disabled:opacity-40"}`}
            >
              {voicePending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : auditioning ? (
                <Square className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
              Hear my voice
            </button>
          )}
        </div>

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
    </OnboardingStage>
  );
}
