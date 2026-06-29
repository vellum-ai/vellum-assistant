/**
 * "Create my personality" — five trait sliders the user nudges to shape the
 * assistant's voice, shown between the pitch and the free-credits step.
 *
 * SPIKE — research-onboarding flow.
 *
 * Frontend-only for now: the slider values are held in local state and aren't
 * sent anywhere yet (a later PR will wire them to the assistant's persona). The
 * step is part of the research-onboarding flow (no separate flag). Foreground
 * content only — the shared toned backdrop (avatar color + bottom eyes) sits
 * behind.
 */

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";

interface CreatePersonalityStepProps {
  onContinue: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}

/** The five trait axes, each a 0–100 slider flanked by its end labels. */
interface PersonalityAxis {
  id: string;
  left: string;
  right: string;
}

const PERSONALITY_AXES: PersonalityAxis[] = [
  { id: "companion-coworker", left: "Companion", right: "Coworker" },
  { id: "genz-boomer", left: "Gen Z", right: "Baby Boomer" },
  { id: "execute-collaborate", left: "Execute", right: "Collaborate" },
  { id: "playful-serious", left: "Playful", right: "Serious" },
  { id: "polite-unfiltered", left: "Polite", right: "Unfiltered" },
];

/** Sliders start centered — no axis is nudged either way until the user acts. */
const DEFAULT_VALUE = 50;

/**
 * Slider styling from Figma (node 6279-576): a thick, uniformly-tinted track
 * (Surface-Dark/Lift at low opacity, so it darkens whatever avatar color sits
 * behind it) with a large solid-white thumb (Primary-Dark/Base). Smooth
 * (continuous) drag, no separate filled-range color — the track reads the same
 * on both sides of the thumb.
 */
const TRACK_COLOR = "rgba(36, 41, 46, 0.2)"; // #24292E @ 20%
const THUMB_COLOR = "#FDFDFC";

/** One trait row: left label, the tinted track, right label. */
function PersonalitySlider({
  axis,
  value,
  onValueChange,
  fg,
}: {
  axis: PersonalityAxis;
  value: number;
  onValueChange: (next: number) => void;
  fg: string;
}) {
  // Responsive: on mobile the labels sit on one line split to the slider's two
  // ends (left label hard-left, right label hard-right) above a full-width
  // track, so it's obvious which end each label belongs to; on >=sm they flank
  // the track in a single row. Flex `order` + wrap drives the reflow.
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 sm:flex-nowrap">
      <span
        className="order-1 flex-1 text-left text-body-medium-default sm:w-28 sm:flex-none sm:text-right"
        style={{ color: fg }}
      >
        {axis.left}
      </span>
      <span
        className="order-2 flex-1 text-right text-body-medium-default sm:order-3 sm:w-28 sm:flex-none sm:text-left"
        style={{ color: fg }}
      >
        {axis.right}
      </span>
      <SliderPrimitive.Root
        className="relative order-3 flex h-6 w-full touch-none items-center select-none sm:order-2 sm:w-auto sm:flex-1"
        value={[value]}
        onValueChange={(next) => onValueChange(next[0] ?? DEFAULT_VALUE)}
        min={0}
        max={100}
        step={1}
        aria-label={`${axis.left} to ${axis.right}`}
      >
        <SliderPrimitive.Track
          className="relative h-3 w-full grow rounded-full"
          style={{ backgroundColor: TRACK_COLOR }}
        />
        <SliderPrimitive.Thumb
          className="block h-6 w-6 cursor-grab rounded-full shadow-sm transition-transform active:scale-95 active:cursor-grabbing keyboard-focus:outline-none keyboard-focus:ring-2 keyboard-focus:ring-white/70"
          style={{ backgroundColor: THUMB_COLOR }}
        />
      </SliderPrimitive.Root>
    </div>
  );
}

export function CreatePersonalityStep({
  onContinue,
  onBack,
  onForward,
}: CreatePersonalityStepProps) {
  const tone = useOnboardingTone();
  // Frontend-only: keep each axis' value locally; nothing is persisted yet.
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(PERSONALITY_AXES.map((axis) => [axis.id, DEFAULT_VALUE])),
  );

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div className="absolute left-1/2 top-[14%] flex w-full max-w-2xl -translate-x-1/2 flex-col items-center gap-12 px-6">
        <h1
          className="text-center text-[2.6rem] leading-none"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Create my personality
        </h1>

        <div className="flex w-full flex-col gap-7">
          {PERSONALITY_AXES.map((axis) => (
            <PersonalitySlider
              key={axis.id}
              axis={axis}
              value={values[axis.id] ?? DEFAULT_VALUE}
              onValueChange={(next) =>
                setValues((prev) => ({ ...prev, [axis.id]: next }))
              }
              fg={tone.fg}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={onContinue}
          className="mt-4 flex h-11 w-[234px] cursor-pointer items-center justify-center gap-2 rounded-[10px] text-body-medium-default transition-transform duration-150 active:scale-[0.97]"
          style={{
            backgroundColor: tone.isLight ? "#1A1A1A" : "#FFFFFF",
            color: tone.isLight ? "#FFFFFF" : "#1A1A1A",
          }}
        >
          Continue
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
