/**
 * One personality trait row on the personality page: left label, a thick
 * tinted slider track with a large white thumb, right label. Mirrors the
 * research-onboarding personality step's slider styling (Figma 6279-576) —
 * built from Radix primitives rather than the design-library `Slider`
 * because it renders on the avatar-tinted stage, where the library's
 * token-colored track/thumb don't read.
 */

import * as SliderPrimitive from "@radix-ui/react-slider";

import type { AvatarTone } from "@/utils/avatar-tone";

import {
  PERSONALITY_AXIS_DEFAULT,
  type PersonalityAxisDefinition,
} from "../identity-actions/personality-axes";

/** Uniformly-tinted track — darkens whatever avatar color sits behind it. */
const TRACK_COLOR = "rgba(36, 41, 46, 0.25)";
const THUMB_COLOR = "#FDFDFC";

interface PersonalitySliderRowProps {
  axis: PersonalityAxisDefinition;
  value: number;
  onValueChange: (next: number) => void;
  tone: AvatarTone;
  /** Locked while the rewrite turn is in flight. */
  disabled: boolean;
}

export function PersonalitySliderRow({
  axis,
  value,
  onValueChange,
  tone,
  disabled,
}: PersonalitySliderRowProps) {
  // Responsive: on mobile the labels sit on one line split to the slider's
  // two ends above a full-width track; on >=sm they flank the track in a
  // single row. Flex `order` + wrap drives the reflow.
  return (
    <div
      className="flex w-full shrink-0 flex-wrap items-center gap-x-5 gap-y-1.5 sm:flex-nowrap"
      style={{ opacity: disabled ? 0.7 : 1 }}
    >
      <span
        className="order-1 flex-1 text-left text-sm sm:w-32 sm:flex-none sm:text-right sm:text-[17px]"
        style={{ color: tone.fg }}
      >
        {axis.left}
      </span>
      <span
        className="order-2 flex-1 text-right text-sm sm:order-3 sm:w-32 sm:flex-none sm:text-left sm:text-[17px]"
        style={{ color: tone.fg }}
      >
        {axis.right}
      </span>
      <SliderPrimitive.Root
        className="relative order-3 flex h-6 w-full touch-none items-center select-none sm:order-2 sm:w-auto sm:flex-1"
        value={[value]}
        onValueChange={(next) =>
          onValueChange(next[0] ?? PERSONALITY_AXIS_DEFAULT)
        }
        disabled={disabled}
        min={0}
        max={100}
        step={1}
        aria-label={`${axis.left} to ${axis.right}`}
      >
        <SliderPrimitive.Track
          className="relative h-2 w-full grow rounded-full sm:h-3"
          style={{ backgroundColor: TRACK_COLOR }}
        />
        <SliderPrimitive.Thumb
          className="block h-5 w-5 cursor-grab rounded-full shadow-sm transition-transform active:scale-95 active:cursor-grabbing keyboard-focus:outline-none keyboard-focus:ring-2 keyboard-focus:ring-white/70 data-[disabled]:cursor-not-allowed data-[disabled]:active:scale-100 sm:h-6 sm:w-6"
          style={{ backgroundColor: THUMB_COLOR }}
        />
      </SliderPrimitive.Root>
    </div>
  );
}
