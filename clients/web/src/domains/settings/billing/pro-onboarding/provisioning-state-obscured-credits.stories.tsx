/**
 * The provisioning takeover under the `obscure-credits` flag, where no credit
 * amount may render: the credits chip swaps its row label to "Usage" and names
 * each side by the bundle's catalog label instead of a monthly rate.
 *
 * These live apart from the main takeover stories because the flag is a
 * module-level Zustand singleton. Autodocs mounts every story in a file into
 * one iframe at once, so a story that flips a singleton flips it for its
 * neighbours too, and the flag-off stories would silently document the flag-on
 * treatment. `!autodocs` keeps this file to the Canvas, where one story is
 * mounted at a time.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect } from "react";

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

import { ProvisioningState } from "./provisioning-state";
import {
  CUSTOM_INTENT_THREE_ITEMS,
  TAKEOVER_BASE_ARGS,
  takeoverFrameDecorator,
  takeoverQueryDecorator,
} from "./takeover-story-support";

// Writing the store during render would update every subscriber mid-render,
// and the flag must not outlive these stories, so it is set in an effect and
// handed back on unmount.
const obscureCreditsDecorator: Decorator = function ObscureCreditsFlag(Story) {
  useLayoutEffect(() => {
    const previous =
      useClientFeatureFlagStore.getState().obscureCredits === true;
    useClientFeatureFlagStore
      .getState()
      .setFlags({ obscureCredits: true }, null);
    return () => {
      useClientFeatureFlagStore
        .getState()
        .setFlags({ obscureCredits: previous }, null);
    };
  }, []);
  return <Story />;
};

const meta: Meta<typeof ProvisioningState> = {
  title: "Settings/Billing/ProOnboarding/ProvisioningState (obscured credits)",
  component: ProvisioningState,
  // See the file header: the flag is a singleton, and autodocs would mount
  // these beside stories that document the flag-off treatment.
  tags: ["!autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    ...TAKEOVER_BASE_ARGS,
    state: "WAITING",
  },
  // Storybook applies decorators innermost first, so the flag is already set
  // for the frame and the takeover, both of which sit inside the query
  // provider that answers their reads.
  decorators: [
    takeoverFrameDecorator,
    obscureCreditsDecorator,
    takeoverQueryDecorator,
  ],
};

export default meta;
type Story = StoryObj<typeof ProvisioningState>;

/**
 * Taking a bundle on an assistant that had none. The row label reads "Usage",
 * the from-side is the explicit no-bundle sentinel, and the to-side is the
 * bundle's catalog name rather than the rate it bills at.
 */
export const WaitingBundleAdded: Story = {
  name: "Waiting · bundle added",
  args: {
    state: "WAITING",
    creditsChange: { fromTier: null, toTier: "credits_25" },
  },
};

/**
 * A custom checkout confirming with a bundle picked. The bundle chip waits on
 * the plan catalog for its wording, and reads "Super Usage" rather than the
 * credit count the flag-off chip states.
 */
export const ConfirmingCustomIntentBundle: Story = {
  name: "Confirming · custom intent bundle",
  args: {
    state: "CONFIRMING",
    intent: CUSTOM_INTENT_THREE_ITEMS,
  },
};
