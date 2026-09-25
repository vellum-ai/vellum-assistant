/**
 * The Email tab hanging off the Channels tile in the assistant profile's
 * bottom strip: the two are one piece, square where they meet, the tab in
 * the feature cards' wash of the avatar colour, with a lock when the org's
 * plan has no managed email. The
 * bench sets the same card variables the overview derives from the avatar,
 * so the wash reads as it does on the page.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CSSProperties, ReactNode } from "react";

import { buildIdentitySections } from "./identity-sections";
import { SectionCard } from "./identity-overview";

const AVATAR_HEX = "#9b6bd6";

const WASH: CSSProperties = {
  "--card-accent": AVATAR_HEX,
  "--card-bg": `color-mix(in srgb, ${AVATAR_HEX} 5%, var(--surface-lift))`,
  "--card-feature-bg": `color-mix(in srgb, var(--card-accent) 28%, var(--surface-lift))`,
  "--card-hover": `color-mix(in srgb, ${AVATAR_HEX} 22%, var(--surface-lift))`,
} as CSSProperties;

function strip(locked: boolean) {
  const sections = buildIdentitySections({ email: { locked } });
  return sections.filter((s) =>
    ["contacts", "channels", "email"].includes(s.key),
  );
}

const STATS: Record<string, { text: string } | undefined> = {
  contacts: { text: "12 people" },
  channels: { text: "3 connected" },
};

function Bench({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-col gap-6 bg-[var(--surface-base)] p-10"
      style={WASH}
    >
      {children}
    </div>
  );
}

function Pair({
  sections,
  compact = false,
}: {
  sections: ReturnType<typeof strip>;
  compact?: boolean;
}) {
  const channels = sections.find((s) => s.key === "channels")!;
  const email = sections.find((s) => s.key === "email")!;
  return (
    <div className="flex min-w-0 flex-[1.7]">
      <SectionCard
        section={channels}
        stat={STATS[channels.key]}
        hoverFill
        mini
        compact={compact}
        join="end"
      />
      <SectionCard
        section={email}
        stat={undefined}
        hoverFill
        mini
        compact={compact}
        join="start"
        fit
      />
    </div>
  );
}

function Strip({ locked }: { locked: boolean }) {
  const sections = strip(locked);
  const contacts = sections.find((s) => s.key === "contacts")!;
  return (
    <div className="flex h-16 w-[720px] items-stretch gap-3">
      <SectionCard
        section={contacts}
        stat={STATS[contacts.key]}
        hoverFill
        mini
      />
      <Pair sections={sections} />
    </div>
  );
}

const meta = {
  title: "Intelligence/Email Tile",
  component: Strip,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Strip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** On a plan with managed email: the tile is the way into the inbox. */
export const Unlocked: Story = {
  args: { locked: false },
  render: (args) => (
    <Bench>
      <Strip {...args} />
    </Bench>
  ),
};

/** Without it: the same tile, locked, still leading to the inbox's pitch. */
export const Locked: Story = {
  args: { locked: true },
  render: (args) => (
    <Bench>
      <Strip {...args} />
    </Bench>
  ),
};

/** The phone's stacked grid: two columns, Email a tile like the others. */
export const Stacked: Story = {
  args: { locked: false },
  render: () => (
    <Bench>
      <div className="grid w-[360px] grid-cols-2 gap-2">
        <SectionCard
          section={strip(false).find((s) => s.key === "contacts")!}
          stat={STATS["contacts"]}
          hoverFill
          mini
          compact
        />
        <div className="col-span-2 flex min-w-0">
          <Pair sections={strip(false)} compact />
        </div>
      </div>
    </Bench>
  ),
};

/** Both, to judge the wash against the plain tiles beside it. */
export const Both: Story = {
  args: { locked: false },
  render: () => (
    <Bench>
      <Strip locked={false} />
      <Strip locked />
    </Bench>
  ),
};
