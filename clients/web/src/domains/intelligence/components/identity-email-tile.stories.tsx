/**
 * The Email row over the Channels tile in the assistant profile's bottom
 * strip: one slim line at the tile's width, in the feature cards' wash of
 * the avatar colour, with a lock when the org's plan has no managed email. The bench
 * sets the same card variables the overview derives from the avatar, so
 * the wash reads as it does on the page.
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
    ["contacts", "email", "channels"].includes(s.key),
  );
}

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

function Strip({ locked }: { locked: boolean }) {
  const sections = strip(locked);
  const email = sections.find((s) => s.key === "email")!;
  return (
    <div className="flex w-[640px] flex-col gap-3 pt-12">
      <div className="flex h-16 items-stretch gap-3">
        {sections
          .filter((s) => s.key !== "email")
          .map((section) =>
            section.key === "channels" ? (
              <div key={section.key} className="relative flex min-w-0 flex-1">
                <div className="absolute bottom-full left-0 max-w-full">
                  <SectionCard
                    section={email}
                    stat={undefined}
                    hoverFill
                    slim
                  />
                </div>
                <SectionCard
                  section={section}
                  stat={{ text: "3 connected" }}
                  hoverFill
                  mini
                  tabbed
                />
              </div>
            ) : (
              <SectionCard
                key={section.key}
                section={section}
                stat={{ text: "12 people" }}
                hoverFill
                mini
              />
            ),
          )}
      </div>
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

/** Both, to judge the wash against the plain tiles either side. */
export const Both: Story = {
  args: { locked: false },
  render: () => (
    <Bench>
      <Strip locked={false} />
      <Strip locked />
    </Bench>
  ),
};
