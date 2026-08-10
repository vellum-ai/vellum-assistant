/**
 * The five personality sliders, with an avatar peeking in from each screen edge
 * as a slider is dragged toward that end.
 *
 * The peeking avatars anchor to the edge of the box they live in. `50%` in a
 * CSS inset resolves against the containing block and `vw` against the layout
 * viewport, so anchoring with a mix of the two only lands correctly while the
 * stage is exactly viewport-width. `LandscapeWithSideInsets` is the story that
 * holds that honest: the app shell pads by `env(safe-area-inset-left/right)`,
 * and an avatar anchored to the viewport is pushed
 * `(stageWidth - viewportWidth) / 2` outside the stage, where `overflow-hidden`
 * clips it.
 *
 * The avatars are hidden below 640px, so every story here is wider than that.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { CreatePersonalityStep } from "./create-personality-step";
import { OnboardingStage } from "@/domains/onboarding/components/onboarding-stage";
import { StageHost } from "@/domains/onboarding/components/onboarding-story-fixtures";

/** Every slider at its right end, so all five right-side avatars are fully in. */
const ALL_RIGHT: Record<string, number> = {
  "companion-coworker": 100,
  "genz-boomer": 100,
  "execute-collaborate": 100,
  "playful-serious": 100,
  "polite-unfiltered": 100,
};

const meta: Meta<typeof CreatePersonalityStep> = {
  title: "Onboarding/CreatePersonalityStep",
  parameters: { layout: "fullscreen" },
  args: {
    values: ALL_RIGHT,
    locked: false,
    onContinue: () => {},
    onBack: () => {},
  },
  argTypes: {
    locked: { control: "boolean" },
    values: { control: "object" },
  },
  render: function Render(args) {
    // Controlled component: the route owns `values`, so the story owns them
    // through args and the sliders stay draggable.
    const [{ values }, updateArgs] = useArgs<{
      values: Record<string, number>;
    }>();
    return (
      <StageHost>
        <OnboardingStage className="bg-[var(--surface-base)] text-[var(--content-default)]">
          <CreatePersonalityStep
            {...args}
            values={values}
            onValueChange={(axisId, value) =>
              updateArgs({ values: { ...values, [axisId]: value } })
            }
          />
        </OnboardingStage>
      </StageHost>
    );
  },
};

export default meta;
type Story = StoryObj<typeof CreatePersonalityStep>;

/** Desktop, no insets: the stage is viewport-width, so both boxes agree. */
export const Desktop: Story = {
  globals: { viewport: { value: "sbDesktop" } },
};

/**
 * Landscape on a notched device: the shell pads 59px on the notch side and 34px
 * for the home indicator, so the stage is narrower than the viewport.
 *
 * The peeking avatars should rest against the stage's edge, inside the padded
 * frame. Any of them sitting on the light inset band, or cut off harder than
 * the `EDGE_GAP` intends, is the anchor resolving against the wrong box.
 */
export const LandscapeWithSideInsets: Story = {
  // Rotated phone: 844x390, wide enough for the avatars to render at all
  // (they are hidden below 640px) and the shape a notched device is in when
  // the shell applies left/right insets.
  globals: { viewport: { value: "sbMobile", isRotated: true } },
  render: function Render(args) {
    const [{ values }, updateArgs] = useArgs<{
      values: Record<string, number>;
    }>();
    return (
      <StageHost insetLeft={59} insetRight={34} insetBottom={21}>
        <OnboardingStage className="bg-[var(--surface-base)] text-[var(--content-default)]">
          <CreatePersonalityStep
            {...args}
            values={values}
            onValueChange={(axisId, value) =>
              updateArgs({ values: { ...values, [axisId]: value } })
            }
          />
        </OnboardingStage>
      </StageHost>
    );
  },
};
