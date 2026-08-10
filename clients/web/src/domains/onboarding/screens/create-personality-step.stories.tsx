/**
 * The five personality sliders, with an avatar peeking in from each screen edge
 * as a slider is dragged toward that end.
 *
 * The peeking avatars anchor with `calc(50% - 50vw)`, which mixes two boxes:
 * `50%` resolves against the containing block, `50vw` against the layout
 * viewport. They agree only while the stage is exactly viewport-width, so
 * `LandscapeWithSideInsets` is the story that matters: the app shell pads by
 * `env(safe-area-inset-left/right)` in landscape on a notched device, and the
 * two boxes come apart by that inset.
 *
 * The avatars are hidden below 640px, so every story here is at a width that
 * shows them.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { CreatePersonalityStep } from "./create-personality-step";
import { OnboardingStage } from "@/domains/onboarding/components/onboarding-stage";
import {
  SeededAvatarPool,
  StageHost,
} from "@/domains/onboarding/components/onboarding-story-fixtures";

/** Drives the sliders as the route does, so dragging moves the avatars. */
function PersonalityStep({ initial }: { initial?: Record<string, number> }) {
  const [values, setValues] = useState<Record<string, number>>(initial ?? {});
  return (
    <CreatePersonalityStep
      values={values}
      onValueChange={(axisId, value) =>
        setValues((prev) => ({ ...prev, [axisId]: value }))
      }
      locked={false}
      onContinue={() => {}}
      onBack={() => {}}
    />
  );
}

/** Every slider pushed to its right end, so all five right-side avatars show. */
const ALL_RIGHT: Record<string, number> = {
  "companion-coworker": 100,
  "genz-boomer": 100,
  "execute-collaborate": 100,
  "playful-serious": 100,
  "polite-unfiltered": 100,
};

const meta: Meta<typeof CreatePersonalityStep> = {
  title: "Onboarding/CreatePersonalityStep",
  parameters: { layout: "fullscreen", controls: { disable: true } },
  render: () => (
    <StageHost>
      <OnboardingStage className="bg-[var(--surface-base)] text-[var(--content-default)]">
        <SeededAvatarPool>
          <PersonalityStep initial={ALL_RIGHT} />
        </SeededAvatarPool>
      </OnboardingStage>
    </StageHost>
  ),
};

export default meta;
type Story = StoryObj<typeof CreatePersonalityStep>;

/** Desktop, no insets: the stage is viewport-width, so the two boxes agree. */
export const Desktop: Story = {
  globals: { viewport: { value: "sbDesktop" } },
};

/**
 * Landscape on a notched device: the shell pads 59px on the notch side and 34px
 * for the home indicator, so the stage is narrower than the viewport and the
 * `50vw` half of the anchor no longer matches the `50%` half.
 *
 * The peeking avatars should rest against the stage's edge, inside the padded
 * frame. Any part of them sitting on the light inset band is the anchor
 * resolving against the wrong box.
 */
export const LandscapeWithSideInsets: Story = {
  render: () => (
    <StageHost insetLeft={59} insetRight={34} insetTop={0} insetBottom={21}>
      <OnboardingStage className="bg-[var(--surface-base)] text-[var(--content-default)]">
        <SeededAvatarPool>
          <PersonalityStep initial={ALL_RIGHT} />
        </SeededAvatarPool>
      </OnboardingStage>
    </StageHost>
  ),
};
