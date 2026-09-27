/**
 * The Email pill inside the Channels tile of the assistant profile's bottom
 * strip: drawn the way the side menu draws its entries, in the assistant's
 * wash with the glyph in the accent, with a lock when the org's plan has no
 * managed email. The bench sets the same card variables the overview
 * derives from the avatar, so the wash reads as it does on the page.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Mail, Pin, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";

import { buildIdentitySections } from "./identity-sections";
import { SectionCard } from "./identity-overview";

const AVATAR_HEX = "#9b6bd6";

const WASH: CSSProperties = {
  "--card-accent": AVATAR_HEX,
  "--card-bg": `color-mix(in srgb, ${AVATAR_HEX} 5%, var(--surface-lift))`,
  "--card-feature-bg": `color-mix(in srgb, var(--card-accent) 28%, var(--surface-lift))`,
  "--card-hover": `color-mix(in srgb, ${AVATAR_HEX} 22%, var(--surface-lift))`,
} as CSSProperties;

const STATS: Record<string, { text: string } | undefined> = {
  contacts: { text: "12 people" },
  channels: { text: "3 connected" },
};

function Pill({ locked }: { locked: boolean }) {
  const email = buildIdentitySections({ email: { locked } }).find(
    (s) => s.key === "email",
  )!;
  const Control = locked ? X : Pin;
  return (
    <span
      className="inline-flex h-10 shrink-0 items-center gap-1 rounded-full pr-1.5 pl-4 text-body-medium-default text-[var(--content-default)]"
      style={{
        backgroundColor: `color-mix(in srgb, ${AVATAR_HEX} 22%, var(--surface-lift))`,
      }}
    >
      <Link to={email.to} className="inline-flex items-center gap-2 pr-1.5">
        <Mail className="h-5 w-5" style={{ color: AVATAR_HEX }} aria-hidden />
        {email.label}
        {locked ? <span aria-hidden>🔒</span> : null}
      </Link>
      <span className="flex size-7 items-center justify-center rounded-full text-[var(--content-secondary)]">
        <Control className="h-4 w-4" aria-hidden />
      </span>
    </span>
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
  const sections = buildIdentitySections().filter((s) =>
    ["contacts", "channels"].includes(s.key),
  );
  return (
    <div className="flex h-16 w-[720px] items-stretch gap-3">
      {sections.map((section) => (
        <div
          key={section.key}
          className={`flex min-w-0 ${section.key === "channels" ? "flex-[1.6]" : "flex-1"}`}
        >
          <SectionCard
            section={section}
            stat={STATS[section.key]}
            hoverFill
            mini
            aside={
              section.key === "channels" ? <Pill locked={locked} /> : undefined
            }
          />
        </div>
      ))}
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

/** On a plan with managed email: the pill is the way into the inbox. */
export const Unlocked: Story = {
  args: { locked: false },
  render: (args) => (
    <Bench>
      <Strip {...args} />
    </Bench>
  ),
};

/** Without it: the same pill, locked, still leading to the inbox's pitch. */
export const Locked: Story = {
  args: { locked: true },
  render: (args) => (
    <Bench>
      <Strip {...args} />
    </Bench>
  ),
};

/** The phone's stacked grid: Channels takes both columns to hold the pill. */
export const Stacked: Story = {
  args: { locked: false },
  render: () => {
    const sections = buildIdentitySections().filter((s) =>
      ["contacts", "channels"].includes(s.key),
    );
    return (
      <Bench>
        <div className="grid w-[360px] grid-cols-2 gap-2">
          {sections.map((section) => (
            <div
              key={section.key}
              className={`flex min-w-0 ${section.key === "channels" ? "col-span-2" : ""}`}
            >
              <SectionCard
                section={section}
                stat={STATS[section.key]}
                hoverFill
                mini
                compact
                aside={
                  section.key === "channels" ? (
                    <Pill locked={false} />
                  ) : undefined
                }
              />
            </div>
          ))}
        </div>
      </Bench>
    );
  },
};

/** Both, to judge the wash against the tile it sits in. */
export const Both: Story = {
  args: { locked: false },
  render: () => (
    <Bench>
      <Strip locked={false} />
      <Strip locked />
    </Bench>
  ),
};
