import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  portOfferSurface,
  portPromptBlockSurface,
  specificsCardSurface,
} from "./activation-personas";
import {
  PersonaColumns,
  StaticSurface,
  SurfacePreview,
} from "./activation-story-helpers";

/**
 * Moment 1: Port — the assistant arrives generic and, after two pastes, arrives
 * specific. The specifics card is the ownership moment; its bullets must read
 * back the user's own language. See activation-moments-visual-spec.md §"Moment 1".
 */
const meta: Meta = {
  title: "ActivationFlow/Moment1-Port",
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-[1100px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

export const OfferCard: Story = {
  render: () => (
    <PersonaColumns
      render={(p) => <SurfacePreview initialSurface={portOfferSurface(p)} />}
    />
  ),
};

export const PromptBlock: Story = {
  render: () => (
    <PersonaColumns
      render={(p) => <StaticSurface surface={portPromptBlockSurface(p)} />}
    />
  ),
};

export const SpecificsCardDefault: Story = {
  name: "SpecificsCard (3-bullet)",
  render: () => (
    <PersonaColumns
      render={(p) => <StaticSurface surface={specificsCardSurface(p, 3)} />}
    />
  ),
};

export const SpecificsCardRich: Story = {
  name: "SpecificsCard (4-bullet, rich paste)",
  render: () => (
    <PersonaColumns
      render={(p) => <StaticSurface surface={specificsCardSurface(p, 4)} />}
    />
  ),
};

export const SpecificsCardThin: Story = {
  name: "SpecificsCard (2-bullet, thin paste)",
  render: () => (
    <PersonaColumns
      render={(p) => <StaticSurface surface={specificsCardSurface(p, 2)} />}
    />
  ),
};
