/**
 * The assistant's eyes, from the same control points the widget draws.
 *
 * Unlike the SF Symbols beside them these are exact: `AvatarEyeScleraShape` and
 * `AvatarEyePupilShape` are hand-drawn Beziers in their own design boxes, and
 * the numbers below are those control points transcribed one for one. The
 * pupil fills most of the white and presses against its right edge, which is
 * the whole trick: small centered dots read as punctuation, a heavy sideways
 * pair reads as a face caught mid-glance.
 *
 * Everything is drawn in the eye's own 28x33 design box and scaled by the
 * viewBox, so the ratios below read the same as the Swift's.
 *
 * @see clients/ios/App/VoiceActivity/Widgets/WidgetAvatarRendering.swift
 */

import { useId } from "react";

import { widgetTheme, type WidgetAppearance } from "./widget-tokens";

/** The eye's design box, and the pupil's. */
const EYE_BOX = { width: 28, height: 33 };
const PUPIL_BOX = { width: 18, height: 21 };

/** `WidgetAvatarEyes`: every ratio below is a share of eye height. */
const WIDTH_RATIO = EYE_BOX.width / EYE_BOX.height;
const GAP_RATIO = 5 / 33;

/** The pupil's drawn size and placement, in the eye's design box. */
const PUPIL_WIDTH = 18;
const PUPIL_HEIGHT = 21.5;
const PUPIL_OFFSET_X = 9;
const PUPIL_OFFSET_Y = 6.5;

/** `WidgetAvatarEyes.defaultEyeHeight`. */
export const DEFAULT_EYE_HEIGHT = 33;

/** The pair's width as a share of its height, for callers that place it. */
export const EYE_PAIR_ASPECT = 61 / 33;

/** `AvatarEyeScleraShape`, in its 28x33 design box. */
const SCLERA_PATH =
  "M13.34 0.02C21.06 -0.41 27.61 6.61 27.98 15.71C28.36 24.80 22.41 32.53 14.69 32.98C6.96 33.43 0.39 26.40 0.02 17.30C-0.36 8.19 5.61 0.45 13.34 0.02Z";

/** `AvatarEyePupilShape`, in its 18x21 design box. */
const PUPIL_PATH =
  "M7.77 0.10C12.70 -0.70 17.25 3.33 17.92 9.09C18.59 14.85 15.12 20.14 10.18 20.91C5.27 21.67 0.75 17.64 0.08 11.91C-0.58 6.17 2.85 0.89 7.77 0.10Z";

/** Places the pupil in the eye's box at the size the eye draws it. */
const PUPIL_TRANSFORM = `translate(${PUPIL_OFFSET_X} ${PUPIL_OFFSET_Y}) scale(${PUPIL_WIDTH / PUPIL_BOX.width} ${PUPIL_HEIGHT / PUPIL_BOX.height})`;

interface WidgetAvatarEyesProps {
  /** The one number the pair is sized from. */
  eyeHeight?: number;
  appearance: WidgetAppearance;
  /**
   * Whether the system has flattened the widget (a themed Home Screen, StandBy,
   * the lock screen). Flattened, the pupil is punched out of the white as a
   * hole rather than painted on it, because those modes discard every color and
   * keep only alpha.
   */
  flattened?: boolean;
}

export function WidgetAvatarEyes({
  eyeHeight = DEFAULT_EYE_HEIGHT,
  appearance,
  flattened = false,
}: WidgetAvatarEyesProps) {
  return (
    <div
      style={{
        display: "flex",
        gap: eyeHeight * GAP_RATIO,
        alignItems: "center",
      }}
      aria-hidden="true"
    >
      <Eye
        eyeHeight={eyeHeight}
        appearance={appearance}
        flattened={flattened}
      />
      <Eye
        eyeHeight={eyeHeight}
        appearance={appearance}
        flattened={flattened}
      />
    </div>
  );
}

function Eye({
  eyeHeight,
  appearance,
  flattened,
}: Required<WidgetAvatarEyesProps>) {
  const maskId = useId();
  const sclera = flattened
    ? "rgba(255, 255, 255, 0.75)"
    : widgetTheme.avatarSclera[appearance];

  return (
    <svg
      width={eyeHeight * WIDTH_RATIO}
      height={eyeHeight}
      viewBox={`0 0 ${EYE_BOX.width} ${EYE_BOX.height}`}
      aria-hidden="true"
    >
      {flattened ? (
        <mask id={maskId}>
          <path d={SCLERA_PATH} fill="#FFFFFF" />
          <g transform={PUPIL_TRANSFORM}>
            <path d={PUPIL_PATH} fill="#000000" />
          </g>
        </mask>
      ) : null}
      <path
        d={SCLERA_PATH}
        fill={sclera}
        mask={flattened ? `url(#${maskId})` : undefined}
      />
      {flattened ? null : (
        <g transform={PUPIL_TRANSFORM}>
          <path d={PUPIL_PATH} fill={widgetTheme.avatarPupil[appearance]} />
        </g>
      )}
    </svg>
  );
}
