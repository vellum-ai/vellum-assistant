/**
 * The eyes that peek up from the bottom of an onboarding screen.
 *
 * These exist for one measurement. The eyes size and place themselves from
 * `useOnboardingStageSize()`, so they are anchored to the bottom of the *stage*,
 * not the bottom of the window. On a notched device those are 93px apart
 * (`InsetByASafeArea` below), and nothing in the running app shows both cases
 * side by side.
 *
 * The shared `PeekingEyes` it renders takes that stage box as a prop, yet reads
 * `window.innerWidth` / `innerHeight` directly for its cursor parallax. That
 * mixture is the subject of LUM-3198; these stories are what make the
 * difference between the two boxes visible rather than argued about.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import { OnboardingPeekingEyes } from "./onboarding-peeking-eyes";
import { OnboardingStage } from "./onboarding-stage";
import { SeededAvatarPool, StageHost } from "./onboarding-story-fixtures";

const meta: Meta<typeof OnboardingPeekingEyes> = {
  title: "Onboarding/OnboardingPeekingEyes",
  parameters: { layout: "fullscreen" },
  argTypes: {
    entrance: { control: "boolean" },
    entranceDelay: { control: { type: "number", step: 0.1 } },
  },
  args: { entrance: false },
  render: (args) => (
    <StageHost>
      <OnboardingStage className="bg-[var(--surface-base)]">
        <SeededAvatarPool>
          <OnboardingPeekingEyes {...args} />
        </SeededAvatarPool>
      </OnboardingStage>
    </StageHost>
  ),
};

export default meta;
type Story = StoryObj<typeof OnboardingPeekingEyes>;

/** At rest, cut off by the stage's bottom edge. */
export const Resting: Story = {};

/** The Introduction step's grow-in, delayed behind the body cover. */
export const Entrance: Story = {
  args: { entrance: true, entranceDelay: 0.3 },
};

/** Phone width, where the eyes are sized from the smaller stage dimension. */
export const Mobile: Story = {
  globals: { viewport: { value: "sbMobile" } },
};

/**
 * The stage inset by a notched device's safe area, so the stage is 93px shorter
 * than the window (measured: a 390x844 viewport gives a 390x751 stage).
 *
 * The eyes should sit on the stage's bottom edge, above the home-indicator band,
 * not behind it. If they ever anchor to the window instead, this is the story
 * where that shows up as the eyes sliding under the bottom band.
 */
export const InsetByASafeArea: Story = {
  globals: { viewport: { value: "sbMobile" } },
  render: (args) => (
    // iPhone 15 Pro insets: 59pt status/Dynamic Island, 34pt home indicator.
    <StageHost insetTop={59} insetBottom={34}>
      <OnboardingStage className="bg-[var(--surface-base)]">
        <SeededAvatarPool>
          <OnboardingPeekingEyes {...args} />
        </SeededAvatarPool>
      </OnboardingStage>
    </StageHost>
  ),
};
