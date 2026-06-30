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
 * On desktop, each slider has a personality avatar peeking in from each screen
 * edge — one per end label (ten in all). Dead-center, both hide; the further
 * the user drags toward an end, the further that end's avatar pokes in. They're
 * scattered down the page edges (NOT aligned to their slider row) so they read
 * as a loose crowd reacting to the choices. (Hidden on mobile, where the narrow
 * track leaves no room for them.)
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";
import {
  preloadBundledAvatarComponents,
  useBundledAvatarComponents,
} from "@/utils/use-bundled-avatar-components";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

// Warm the (~48 kB) bundled-avatar chunk the moment this lazy step's module
// loads, so the peeking characters are ready by the time it paints.
preloadBundledAvatarComponents();

/** Below this viewport width the peeking avatars are hidden (Tailwind `sm`). */
const DESKTOP_MIN_WIDTH = 640;

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

/**
 * Vertical anchor (viewport-height fraction) for each axis' peeking avatars,
 * scattered down the page rather than pinned to the slider rows — and spaced
 * far enough apart that several on the same edge don't pile up. The same anchor
 * serves both ends of an axis: only one side is ever shown at a time.
 */
const AVATAR_TOPS = ["9%", "27%", "45%", "62%", "79%"];

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

/**
 * Inset (as a fraction of avatar width) from the screen edge at a fully-dragged
 * slider — at the far end the avatar is entirely on-screen with this much gap
 * between it and the edge, then it slides back off-screen toward center.
 */
const EDGE_GAP = 0.16;

/**
 * Keep an avatar's color off the background. The toned backdrop is painted in
 * the selected avatar's color, so a side avatar sharing it would melt into the
 * page. When that happens, swap to another palette color (stable per slot via
 * `seed`); otherwise keep the hand-picked color.
 */
function avoidBackgroundColor(
  preferred: string,
  selectedColor: string | undefined,
  palette: string[],
  seed: number,
): string {
  if (!selectedColor || preferred !== selectedColor) return preferred;
  const options = palette.filter((c) => c !== selectedColor);
  return options.length > 0 ? (options[seed % options.length] ?? preferred) : preferred;
}

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
 * true viewport edge via `calc(50% - 50vw)` — the overlay is full-width, so 50%
 * is screen-center and pulling back 50vw lands on the edge — and to `top` for
 * its scattered vertical slot. `progress` (0 at center → 1 at the far end)
 * drives how far it slides in, plus a little grow + fade so the entrance feels
 * alive. Never intercepts pointer events.
 */
function EdgePeekAvatar({
  components,
  traits,
  side,
  top,
  size,
  progress,
}: {
  components: CharacterComponents;
  traits: CharacterTraits;
  side: "left" | "right";
  top: string;
  size: number;
  progress: number;
}) {
  const p = Math.max(0, Math.min(1, progress));
  // p=0: fully off-screen just past the edge (-100% of its width). p=1: fully
  // on-screen, inset EDGE_GAP from the edge. Travel spans (100% + the gap).
  const travel = 100 + EDGE_GAP * 100;
  const tx = side === "left" ? -100 + travel * p : 100 - travel * p;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute"
      style={{
        [side]: "calc(50% - 50vw)",
        top,
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
        className="order-1 flex-1 text-left text-base sm:w-32 sm:flex-none sm:text-right sm:text-[17px]"
        style={{ color: fg }}
      >
        {axis.left}
      </span>
      <span
        className="order-2 flex-1 text-right text-base sm:order-3 sm:w-32 sm:flex-none sm:text-left sm:text-[17px]"
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

/**
 * Full-bleed layer of the ten peeking avatars, behind the slider column. Each
 * axis' value drives its two edge avatars: the distance from center toward an
 * end (0 → 1) is how far that end's avatar pokes in; the opposite side stays
 * hidden. Scattered down the edges via `AVATAR_TOPS`.
 */
function EdgeAvatarLayer({
  components,
  values,
  sideAvatars,
  size,
}: {
  components: CharacterComponents;
  values: Record<string, number>;
  sideAvatars: { left: CharacterTraits; right: CharacterTraits }[];
  size: number;
}) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
      {PERSONALITY_AXES.map((axis, i) => {
        const value = values[axis.id] ?? DEFAULT_VALUE;
        const leftProgress = Math.max(0, (DEFAULT_VALUE - value) / DEFAULT_VALUE);
        const rightProgress = Math.max(0, (value - DEFAULT_VALUE) / DEFAULT_VALUE);
        const top = AVATAR_TOPS[i] ?? "50%";
        const pair = sideAvatars[i];
        if (!pair) return null;
        return (
          <div key={axis.id}>
            <EdgePeekAvatar
              components={components}
              traits={pair.left}
              side="left"
              top={top}
              size={size}
              progress={leftProgress}
            />
            <EdgePeekAvatar
              components={components}
              traits={pair.right}
              side="right"
              top={top}
              size={size}
              progress={rightProgress}
            />
          </div>
        );
      })}
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
  const isDesktop = viewportWidth >= DESKTOP_MIN_WIDTH;
  // The page is painted in the selected avatar's color, so steer the side
  // avatars clear of it (see `avoidBackgroundColor`).
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const selectedColor = characters[selectedIndex]?.color;
  // The peeking avatars are desktop-only and big and bold — scale them with the
  // viewport, with a generous floor and ceiling.
  const avatarSize = Math.round(
    Math.min(300, Math.max(160, viewportWidth * 0.16)),
  );
  // Resolve each axis' two avatars once, swapping any color that matches the
  // background. Stable unless the components or the selected color change.
  const sideAvatars = useMemo(() => {
    const palette = components?.colors.map((c) => c.id) ?? [];
    return PERSONALITY_AXES.map((axis, i) => ({
      left: {
        ...axis.leftAvatar,
        color: avoidBackgroundColor(axis.leftAvatar.color, selectedColor, palette, i * 2),
      },
      right: {
        ...axis.rightAvatar,
        color: avoidBackgroundColor(axis.rightAvatar.color, selectedColor, palette, i * 2 + 1),
      },
    }));
  }, [components, selectedColor]);
  // Frontend-only: keep each axis' value locally; nothing is persisted yet.
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(PERSONALITY_AXES.map((axis) => [axis.id, DEFAULT_VALUE])),
  );

  return (
    <div className="absolute inset-0 z-10 overflow-hidden" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      {isDesktop && components && (
        <EdgeAvatarLayer
          components={components}
          values={values}
          sideAvatars={sideAvatars}
          size={avatarSize}
        />
      )}

      <div className="absolute left-1/2 top-[14%] flex w-full max-w-2xl -translate-x-1/2 flex-col items-center gap-10 px-6">
        <h1
          className="text-center text-[2.6rem] leading-none"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Create my personality
        </h1>

        <div className="flex w-full flex-col gap-8 sm:gap-11">
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
