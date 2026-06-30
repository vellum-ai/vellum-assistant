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
 *
 * Each slider has a personality avatar peeking in from each screen edge — one
 * per end label (ten in all). Dead-center, both hide; the further the user
 * drags toward an end, the further that end's avatar pokes in from its edge.
 * It makes the abstract trait axes feel like characters reacting to the choice.
 */

import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";
import {
  preloadBundledAvatarComponents,
  useBundledAvatarComponents,
} from "@/utils/use-bundled-avatar-components";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

// Warm the (~48 kB) bundled-avatar chunk the moment this lazy step's module
// loads, so the peeking characters are ready by the time it paints.
preloadBundledAvatarComponents();

interface CreatePersonalityStepProps {
  onContinue: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}

/**
 * The five trait axes, each a 0–100 slider flanked by its end labels. Each end
 * carries the avatar that peeks in when the slider is dragged toward it — a
 * character whose body/eyes/color evoke that end of the trait (e.g. a warm
 * gentle blob for "Companion", a sharp scowling star for "Execute"). The ten
 * trait-sets are all visually distinct.
 */
interface PersonalityAxis {
  id: string;
  left: string;
  right: string;
  leftAvatar: CharacterTraits;
  rightAvatar: CharacterTraits;
}

const PERSONALITY_AXES: PersonalityAxis[] = [
  {
    id: "companion-coworker",
    left: "Companion",
    right: "Coworker",
    leftAvatar: { bodyShape: "blob", eyeStyle: "gentle", color: "pink" },
    rightAvatar: { bodyShape: "ninja", eyeStyle: "curious", color: "purple" },
  },
  {
    id: "genz-boomer",
    left: "Gen Z",
    right: "Baby Boomer",
    leftAvatar: { bodyShape: "burst", eyeStyle: "quirky", color: "yellow" },
    rightAvatar: { bodyShape: "cloud", eyeStyle: "dazed", color: "green" },
  },
  {
    id: "execute-collaborate",
    left: "Execute",
    right: "Collaborate",
    leftAvatar: { bodyShape: "star", eyeStyle: "angry", color: "orange" },
    rightAvatar: { bodyShape: "flower", eyeStyle: "goofy", color: "teal" },
  },
  {
    id: "playful-serious",
    left: "Playful",
    right: "Serious",
    leftAvatar: { bodyShape: "star", eyeStyle: "goofy", color: "yellow" },
    rightAvatar: { bodyShape: "blob", eyeStyle: "grumpy", color: "purple" },
  },
  {
    id: "polite-unfiltered",
    left: "Polite",
    right: "Unfiltered",
    leftAvatar: { bodyShape: "sprout", eyeStyle: "bashful", color: "green" },
    rightAvatar: { bodyShape: "urchin", eyeStyle: "surprised", color: "orange" },
  },
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

/** Largest fraction of a peeking avatar that pokes past its screen edge. */
const MAX_PEEK = 0.62;

/** Track a live viewport width so the peeking avatars scale with the screen. */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/**
 * One personality avatar peeking in from a screen edge. It's anchored to the
 * true viewport edge via `calc(50% - 50vw)` — the slider column is horizontally
 * centered, so 50% of the (full-width) row sits at screen-center, and pulling
 * back 50vw lands exactly on the edge — no measurement needed. `progress`
 * (0 at center → 1 at the far end) drives how far it slides in, plus a little
 * grow + fade so the entrance feels alive. Sits behind the row's labels/track
 * (`-z-10`) and never intercepts pointer events.
 */
function EdgePeekAvatar({
  components,
  traits,
  side,
  size,
  progress,
}: {
  components: CharacterComponents;
  traits: CharacterTraits;
  side: "left" | "right";
  size: number;
  progress: number;
}) {
  const p = Math.max(0, Math.min(1, progress));
  // Hidden just past the edge at p=0; up to MAX_PEEK of the body shown at p=1.
  const shown = MAX_PEEK * p;
  const tx = side === "left" ? -100 + shown * 100 : 100 - shown * 100;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 -z-10"
      style={{
        [side]: "calc(50% - 50vw)",
        width: size,
        height: size,
        opacity: Math.min(1, p * 1.6),
        transform: `translate(${tx}%, -50%) scale(${0.8 + 0.2 * p})`,
        transformOrigin: `${side} center`,
        transition:
          "transform 0.18s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease",
        willChange: "transform, opacity",
      }}
    >
      <AnimatedAvatar
        components={components}
        traits={traits}
        size={size}
        breathe={false}
      />
    </div>
  );
}

/** One trait row: edge avatars, left label, the tinted track, right label. */
function PersonalitySlider({
  axis,
  value,
  onValueChange,
  fg,
  components,
  avatarSize,
}: {
  axis: PersonalityAxis;
  value: number;
  onValueChange: (next: number) => void;
  fg: string;
  components: CharacterComponents | null;
  avatarSize: number;
}) {
  // Distance from center toward each end, 0 (centered) → 1 (hard against the
  // end). Only one side is ever non-zero, so the opposite avatar stays hidden.
  const leftProgress = Math.max(0, (DEFAULT_VALUE - value) / DEFAULT_VALUE);
  const rightProgress = Math.max(0, (value - DEFAULT_VALUE) / DEFAULT_VALUE);

  // Responsive: on mobile the labels sit on one line split to the slider's two
  // ends (left label hard-left, right label hard-right) above a full-width
  // track, so it's obvious which end each label belongs to; on >=sm they flank
  // the track in a single row. Flex `order` + wrap drives the reflow.
  return (
    <div className="relative flex flex-wrap items-center gap-x-5 gap-y-1.5 sm:flex-nowrap">
      {components && (
        <>
          <EdgePeekAvatar
            components={components}
            traits={axis.leftAvatar}
            side="left"
            size={avatarSize}
            progress={leftProgress}
          />
          <EdgePeekAvatar
            components={components}
            traits={axis.rightAvatar}
            side="right"
            size={avatarSize}
            progress={rightProgress}
          />
        </>
      )}
      <span
        className="relative z-[1] order-1 flex-1 text-left text-base sm:w-32 sm:flex-none sm:text-right sm:text-lg"
        style={{ color: fg }}
      >
        {axis.left}
      </span>
      <span
        className="relative z-[1] order-2 flex-1 text-right text-base sm:order-3 sm:w-32 sm:flex-none sm:text-left sm:text-lg"
        style={{ color: fg }}
      >
        {axis.right}
      </span>
      <SliderPrimitive.Root
        className="relative z-[1] order-3 flex h-7 w-full touch-none items-center select-none sm:order-2 sm:w-auto sm:flex-1"
        value={[value]}
        onValueChange={(next) => onValueChange(next[0] ?? DEFAULT_VALUE)}
        min={0}
        max={100}
        step={1}
        aria-label={`${axis.left} to ${axis.right}`}
      >
        <SliderPrimitive.Track
          className="relative h-3 w-full grow rounded-full sm:h-4"
          style={{ backgroundColor: TRACK_COLOR }}
        />
        <SliderPrimitive.Thumb
          className="block h-6 w-6 cursor-grab rounded-full shadow-sm transition-transform active:scale-95 active:cursor-grabbing keyboard-focus:outline-none keyboard-focus:ring-2 keyboard-focus:ring-white/70 sm:h-7 sm:w-7"
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
  const components = useBundledAvatarComponents();
  const viewportWidth = useViewportWidth();
  // Scale the peeking avatars with the viewport: big and bold on desktop,
  // restrained on phones so they don't swamp the narrow track.
  const avatarSize = Math.round(
    Math.min(120, Math.max(64, viewportWidth * 0.085)),
  );
  // Frontend-only: keep each axis' value locally; nothing is persisted yet.
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(PERSONALITY_AXES.map((axis) => [axis.id, DEFAULT_VALUE])),
  );

  return (
    <div className="absolute inset-0 z-10 overflow-hidden" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div className="absolute left-1/2 top-[14%] flex w-full max-w-3xl -translate-x-1/2 flex-col items-center gap-12 px-6">
        <h1
          className="text-center text-[2.6rem] leading-none"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Create my personality
        </h1>

        <div className="flex w-full flex-col gap-11 sm:gap-14">
          {PERSONALITY_AXES.map((axis) => (
            <PersonalitySlider
              key={axis.id}
              axis={axis}
              value={values[axis.id] ?? DEFAULT_VALUE}
              onValueChange={(next) =>
                setValues((prev) => ({ ...prev, [axis.id]: next }))
              }
              fg={tone.fg}
              components={components}
              avatarSize={avatarSize}
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
