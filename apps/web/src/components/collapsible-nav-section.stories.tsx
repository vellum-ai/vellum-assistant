import type { Meta, StoryObj } from "@storybook/react-vite";
import { Clock, MessageSquare, Pin, Star } from "lucide-react";
import type { ReactNode } from "react";

import { CollapsibleNavSection } from "./collapsible-nav-section";

interface NavSectionStoryArgs {
  label: string;
  showIcon: boolean;
  showTrailing: boolean;
  defaultOpen: boolean;
}

const meta: Meta<NavSectionStoryArgs> = {
  title: "Components/CollapsibleNavSection",
  parameters: {
    layout: "padded",
  },
  argTypes: {
    label: { control: "text" },
    showIcon: { control: "boolean" },
    showTrailing: { control: "boolean" },
    defaultOpen: { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<NavSectionStoryArgs>;

function NavRow({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md px-3 py-1.5 text-body-small-default text-[var(--content-secondary)] hover:bg-[var(--surface-lift)]">
      {children}
    </div>
  );
}

export const Default: Story = {
  args: {
    label: "Recents",
    showIcon: true,
    showTrailing: false,
    defaultOpen: true,
  },
  render: ({ label, showIcon, showTrailing, defaultOpen }) => (
    <div className="w-[260px]">
      <CollapsibleNavSection.Root
        type="multiple"
        defaultValue={defaultOpen ? ["section"] : []}
      >
        <CollapsibleNavSection.Section
          value="section"
          icon={showIcon ? Clock : undefined}
          label={label}
          trailing={
            showTrailing ? (
              <span className="text-body-small-default text-[var(--content-tertiary)]">
                12
              </span>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-0.5 pl-6">
            <NavRow>New conversation</NavRow>
            <NavRow>Plan a trip to Tokyo</NavRow>
            <NavRow>Refactor sidebar component</NavRow>
            <NavRow>Quarterly planning notes</NavRow>
          </div>
        </CollapsibleNavSection.Section>
      </CollapsibleNavSection.Root>
    </div>
  ),
};

export const MultipleSections: Story = {
  parameters: {
    controls: { disable: true },
    docs: {
      description: {
        story:
          "Multiple sections sharing a single root — `type=\"multiple\"` lets several stay open at once.",
      },
    },
  },
  render: () => (
    <div className="w-[260px]">
      <CollapsibleNavSection.Root
        type="multiple"
        defaultValue={["pinned", "recents"]}
      >
        <CollapsibleNavSection.Section
          value="pinned"
          icon={Pin}
          label="Pinned"
          trailing={
            <span className="text-body-small-default text-[var(--content-tertiary)]">
              3
            </span>
          }
        >
          <div className="flex flex-col gap-0.5 pl-6">
            <NavRow>Daily standup</NavRow>
            <NavRow>Roadmap Q3</NavRow>
            <NavRow>Hiring loop</NavRow>
          </div>
        </CollapsibleNavSection.Section>
        <CollapsibleNavSection.Section
          value="recents"
          icon={Clock}
          label="Recents"
        >
          <div className="flex flex-col gap-0.5 pl-6">
            <NavRow>Plan a trip to Tokyo</NavRow>
            <NavRow>Refactor sidebar component</NavRow>
          </div>
        </CollapsibleNavSection.Section>
        <CollapsibleNavSection.Section
          value="favorites"
          icon={Star}
          label="Favorites"
        >
          <div className="flex flex-col gap-0.5 pl-6">
            <NavRow>Saved snippet</NavRow>
          </div>
        </CollapsibleNavSection.Section>
      </CollapsibleNavSection.Root>
    </div>
  ),
};

export const NoIcon: Story = {
  args: {
    label: "Conversations",
    showIcon: false,
    showTrailing: false,
    defaultOpen: true,
  },
  render: ({ label, showTrailing, defaultOpen }) => (
    <div className="w-[260px]">
      <CollapsibleNavSection.Root
        type="multiple"
        defaultValue={defaultOpen ? ["section"] : []}
      >
        <CollapsibleNavSection.Section
          value="section"
          label={label}
          trailing={
            showTrailing ? (
              <span className="text-body-small-default text-[var(--content-tertiary)]">
                5
              </span>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-0.5 pl-6">
            <NavRow>
              <MessageSquare className="mr-2 inline h-3.5 w-3.5" />
              First conversation
            </NavRow>
            <NavRow>Second conversation</NavRow>
          </div>
        </CollapsibleNavSection.Section>
      </CollapsibleNavSection.Root>
    </div>
  ),
};
