/**
 * Visual reference for `CollapsibleNavSection`.
 *
 * Everything here renders through the real components - `SideMenu`,
 * `SideMenu.SubList`, `SideMenu.Item` - inside a real `SideMenu` shell, with
 * no story-local styling. That is deliberate: this story previously drew its
 * rows with a private `NavRow` helper (its own padding, its own type token,
 * its own hover) wrapped in a hand-rolled `flex flex-col gap-0.5 pl-6` div, so
 * it showed a section that looked nothing like any section the app ships. A
 * story that restyles its own children can't catch a regression in the
 * components it claims to document.
 *
 * If a section ever needs a layout this story can't express with the shipped
 * primitives, that's the signal to add the missing primitive - not to
 * hand-roll it here.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Clock, MessageSquare, Pin, Star } from "lucide-react";
import type { ReactNode } from "react";

import { SideMenu } from "@vellumai/design-library";

import { CollapsibleNavSection } from "./collapsible-nav-section";

interface NavSectionStoryArgs {
  label: string;
  showIcon: boolean;
  showTrailing: boolean;
  defaultOpen: boolean;
}

const meta: Meta<NavSectionStoryArgs> = {
  title: "Components/CollapsibleNavSection",
  globals: {
    viewport: { value: "sbDesktop", isRotated: false },
  },
  parameters: {
    layout: "padded",
    viewport: {
      options: {
        sbDesktop: {
          name: "Desktop",
          styles: { width: "1280px", height: "760px" },
          type: "desktop",
        },
      },
    },
    /* Section headers and rows carry `max-md:` variants for the mobile drawer
       (16px type, 46px rows instead of 14px/30px). Those key off the
       *viewport*, so at a narrow browser window these stories would render the
       mobile drawer's metrics while still showing the `rail` variant, a
       combination the app never ships. The pinned viewport above holds the
       Canvas at desktop width regardless of window size.

       It does not reach the Docs canvas: every story on a docs page shares one
       iframe, so no per-story viewport applies there, and that iframe runs
       roughly 300px narrower than the window. Read these in Canvas, or widen
       the window past ~1070px for Docs. Tracked in LUM-2921. */
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

/**
 * The sidebar shell every section really lives in. `SideMenu` owns the
 * surface, the width, and the collapsed-rail context its children read, so
 * rendering a section outside one would exercise a configuration that never
 * ships.
 */
function SideMenuFrame({ children }: { children: ReactNode }) {
  return (
    <div className="w-[280px] bg-[var(--surface-base)]">
      <SideMenu ariaLabel="Navigation preview" collapsed={false} variant="rail">
        <SideMenu.Body>{children}</SideMenu.Body>
      </SideMenu>
    </div>
  );
}

/** A count chip, the one trailing affordance these sections use. */
function CountBadge({ children }: { children: ReactNode }) {
  return (
    <span className="text-body-small-default text-[var(--content-tertiary)]">
      {children}
    </span>
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
    <SideMenuFrame>
      <CollapsibleNavSection.Root
        type="multiple"
        className="gap-3"
        defaultValue={defaultOpen ? ["section"] : []}
      >
        <CollapsibleNavSection.Section
          value="section"
          icon={showIcon ? Clock : undefined}
          label={label}
          trailing={showTrailing ? <CountBadge>12</CountBadge> : undefined}
        >
          <SideMenu.SubList>
            <SideMenu.Item label="New conversation" />
            <SideMenu.Item label="Plan a trip to Tokyo" />
            <SideMenu.Item label="Refactor sidebar component" active />
            <SideMenu.Item label="Quarterly planning notes" />
          </SideMenu.SubList>
        </CollapsibleNavSection.Section>
      </CollapsibleNavSection.Root>
    </SideMenuFrame>
  ),
};

export const MultipleSections: Story = {
  parameters: {
    controls: { disable: true },
    docs: {
      description: {
        story:
          'Multiple sections sharing a single root - `type="multiple"` lets several stay open at once, and the root\'s gap is the only thing between them, so every section boundary is spaced identically.',
      },
    },
  },
  render: () => (
    <SideMenuFrame>
      <CollapsibleNavSection.Root
        type="multiple"
        className="gap-3"
        defaultValue={["pinned", "recents"]}
      >
        <CollapsibleNavSection.Section
          value="pinned"
          icon={Pin}
          label="Pinned"
          trailing={<CountBadge>3</CountBadge>}
        >
          <SideMenu.SubList>
            <SideMenu.Item label="Daily standup" />
            <SideMenu.Item label="Roadmap Q3" />
            <SideMenu.Item label="Hiring loop" />
          </SideMenu.SubList>
        </CollapsibleNavSection.Section>
        <CollapsibleNavSection.Section
          value="recents"
          icon={Clock}
          label="Recents"
        >
          <SideMenu.SubList>
            <SideMenu.Item label="Plan a trip to Tokyo" />
            <SideMenu.Item label="Refactor sidebar component" />
          </SideMenu.SubList>
        </CollapsibleNavSection.Section>
        <CollapsibleNavSection.Section
          value="favorites"
          icon={Star}
          label="Favorites"
        >
          <SideMenu.SubList>
            <SideMenu.Item label="Saved snippet" />
          </SideMenu.SubList>
        </CollapsibleNavSection.Section>
      </CollapsibleNavSection.Root>
    </SideMenuFrame>
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
    <SideMenuFrame>
      <CollapsibleNavSection.Root
        type="multiple"
        className="gap-3"
        defaultValue={defaultOpen ? ["section"] : []}
      >
        <CollapsibleNavSection.Section
          value={label}
          label={label}
          trailing={showTrailing ? <CountBadge>5</CountBadge> : undefined}
        >
          <SideMenu.SubList>
            {/* `icon` and `indent` are the shipped way to align rows with and
                without a leading glyph - the reason this story doesn't need
                a margin utility of its own. */}
            <SideMenu.Item icon={MessageSquare} label="First conversation" />
            <SideMenu.Item label="Second conversation" indent />
          </SideMenu.SubList>
        </CollapsibleNavSection.Section>
      </CollapsibleNavSection.Root>
    </SideMenuFrame>
  ),
};
