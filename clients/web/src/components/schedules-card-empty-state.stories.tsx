/**
 * JARVIS-1632: the Schedules card on the assistant profile page.
 *
 * This is the bento card at `identity-overview.tsx:632`, not the Schedules
 * page. When the assistant has schedules the card previews up to three of
 * them as tiles. When it has none, that whole block is skipped and the card
 * renders its header, then several hundred pixels of nothing, then one
 * italic line ("Nothing scheduled yet") pinned to the bottom.
 *
 * The card wraps its entire body in a `<Link to="/assistant/schedules">`, so
 * the empty state cannot introduce buttons: a button inside an anchor is
 * invalid, and the card's whole contract is "glance, then go here". The fix
 * is therefore not a CTA. It is to spend the negative space teaching what a
 * schedule is, using ghosts of the same tiles the populated card draws, and
 * to make the bottom line read as a door rather than a dead end.
 *
 * The ghost tiles name the same two schedules the Schedules page offers as
 * one-tap recipes, so the card teases exactly what the destination hands
 * over.
 *
 * Copy is inline because these are design fixtures. The shipping PR moves it
 * into `i18n/locales/en/intelligence.json` alongside
 * `useIdentitySectionStats.noSchedulesText`.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowRight, Calendar } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { Card } from "@vellumai/design-library";

/** Real schedules the populated card previews, for the reference story. */
const REAL_SCHEDULES = [
  { name: "Morning briefing", meta: "Every weekday at 8:00 . 28 Aug, 8:00 am" },
  { name: "Inbox triage", meta: "Every 2 hours . 27 Aug, 4:00 pm" },
  { name: "Weekly review", meta: "Fridays at 4:00 PM . 29 Aug, 4:00 pm" },
];

/**
 * Suggestions the empty card draws as ghosts. The same two the Schedules
 * page offers as one-tap recipes, so the card teases its own destination.
 */
const GHOST_SCHEDULES = [
  { name: "Morning briefing", meta: "Every weekday at 8:00" },
  { name: "Inbox triage", meta: "Every 2 hours" },
];

/**
 * One schedule tile, matching `identity-overview.tsx:634-660`: a
 * content-tinted wash so it lifts off the card in dark themes too.
 */
function ScheduleTile({
  name,
  meta,
  ghost,
}: {
  name: string;
  meta: string;
  ghost?: boolean;
}) {
  return (
    <span
      className={`flex flex-col gap-0.5 rounded-xl px-3 py-2 ${
        ghost
          ? "border border-dashed border-[var(--border-base)] opacity-60"
          : ""
      }`}
      style={{
        backgroundColor: ghost
          ? "transparent"
          : "color-mix(in srgb, var(--content-default) 5%, transparent)",
      }}
    >
      <span
        className={`truncate text-[13px] font-medium ${
          ghost
            ? "text-[var(--content-tertiary)]"
            : "text-[var(--content-default)]"
        }`}
      >
        {name}
      </span>
      <span className="truncate text-[12px] text-[var(--content-tertiary)]">
        {meta}
      </span>
    </span>
  );
}

/**
 * The card shell: `Card.Root` chrome and the anchor body from
 * `identity-overview.tsx:522-556`, at the size the bento grid gives the
 * Schedules card (one column of five, spanning the first two rows).
 */
function SchedulesCard({
  children,
  footer,
}: {
  children?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Card.Root
      asChild
      bordered={false}
      elevated={false}
      className="rounded-3xl border border-[var(--border-base)] bg-[var(--card-feature-bg,var(--surface-lift))]"
      style={{ width: 260, height: 300 }}
    >
      <a
        href="#schedules"
        className="relative flex h-full w-full cursor-pointer flex-col justify-between gap-3 overflow-hidden p-5 text-left"
      >
        <span className="relative flex items-center gap-2">
          <Calendar
            className="h-5 w-5 text-[var(--content-default)]"
            aria-hidden
          />
          <span className="text-body-medium-default text-[var(--content-default)]">
            Schedules
          </span>
        </span>
        {children}
        {footer}
      </a>
    </Card.Root>
  );
}

/** Side-by-side frame. The tint mimics a character-colored assistant. */
function Bench({
  children,
  tint,
}: {
  children: ReactNode;
  tint?: boolean;
}) {
  const style = tint
    ? ({
        "--card-feature-bg":
          "color-mix(in srgb, #8b5cf6 22%, var(--surface-base))",
      } as CSSProperties)
    : undefined;
  return (
    <div
      className="flex min-h-screen flex-wrap items-start gap-8 bg-[var(--surface-base)] p-10"
      style={style}
    >
      {children}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-label-small-default uppercase tracking-wide text-[var(--content-tertiary)]">
        {label}
      </span>
      {children}
    </div>
  );
}

/** Today's empty card: header, a void, one italic line. */
function CurrentCard() {
  return (
    <SchedulesCard
      footer={
        <span className="relative text-[14px] font-medium italic text-[var(--content-tertiary)]">
          Nothing scheduled yet
        </span>
      }
    />
  );
}

/**
 * Proposal A. The negative space carries two ghost tiles, so the card shows
 * what a schedule is instead of asserting that there are none. The stat line
 * is unchanged, which keeps the card honest about being empty.
 */
function GhostCard() {
  return (
    <SchedulesCard
      footer={
        <span className="relative text-[14px] font-medium italic text-[var(--content-tertiary)]">
          Nothing scheduled yet
        </span>
      }
    >
      <span
        className="relative flex min-h-0 flex-1 flex-col justify-start gap-2 overflow-hidden py-2"
        aria-hidden
      >
        {GHOST_SCHEDULES.map((schedule) => (
          <ScheduleTile key={schedule.name} {...schedule} ghost />
        ))}
      </span>
    </SchedulesCard>
  );
}

/**
 * Proposal B. Same ghosts, but the bottom line stops being a dead stat and
 * becomes the door the card already is: the whole card links to Schedules,
 * where these two suggestions are waiting as one-tap recipes.
 */
function GhostInviteCard() {
  return (
    <SchedulesCard
      footer={
        <span className="relative flex flex-col gap-1">
          <span className="text-[14px] font-medium italic text-[var(--content-tertiary)]">
            Nothing scheduled yet
          </span>
          <span className="flex items-center gap-1 text-[13px] font-medium text-[var(--content-default)]">
            Set one up
            <ArrowRight size={13} aria-hidden />
          </span>
        </span>
      }
    >
      <span
        className="relative flex min-h-0 flex-1 flex-col justify-start gap-2 overflow-hidden py-2"
        aria-hidden
      >
        {GHOST_SCHEDULES.map((schedule) => (
          <ScheduleTile key={schedule.name} {...schedule} ghost />
        ))}
      </span>
    </SchedulesCard>
  );
}

/**
 * Proposal C. No invented schedule names at all: just the tile shapes the
 * card will fill, so nothing on it can be misread as data the user owns.
 * Teaches the shape rather than the content, and pairs with the invitation.
 */
function SkeletonInviteCard() {
  return (
    <SchedulesCard
      footer={
        <span className="relative flex flex-col gap-1">
          <span className="text-[14px] font-medium italic text-[var(--content-tertiary)]">
            Nothing scheduled yet
          </span>
          <span className="flex items-center gap-1 text-[13px] font-medium text-[var(--content-default)]">
            Set one up
            <ArrowRight size={13} aria-hidden />
          </span>
        </span>
      }
    >
      <span
        className="relative flex min-h-0 flex-1 flex-col justify-start gap-2 overflow-hidden py-2"
        aria-hidden
      >
        {[0, 1].map((index) => (
          <span
            key={index}
            className="flex flex-col gap-1.5 rounded-xl border border-dashed border-[var(--border-base)] px-3 py-2.5 opacity-50"
          >
            <span className="h-2 w-24 rounded-full bg-[var(--content-tertiary)]" />
            <span className="h-2 w-16 rounded-full bg-[var(--content-tertiary)] opacity-60" />
          </span>
        ))}
      </span>
    </SchedulesCard>
  );
}

/** The populated card, for reference: what the ghosts are imitating. */
function PopulatedCard() {
  return (
    <SchedulesCard
      footer={
        <span className="relative text-[14px] font-medium italic text-[var(--content-tertiary)]">
          3 scheduled
        </span>
      }
    >
      <span className="relative flex min-h-0 flex-1 flex-col justify-start gap-2 overflow-hidden py-2">
        {REAL_SCHEDULES.map((schedule) => (
          <ScheduleTile key={schedule.name} {...schedule} />
        ))}
      </span>
    </SchedulesCard>
  );
}

const meta = {
  title: "Empty States/Schedules Card",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** All four side by side: today, both proposals, and the populated card. */
export const Comparison: Story = {
  render: () => (
    <Bench>
      <Labeled label="Today">
        <CurrentCard />
      </Labeled>
      <Labeled label="A. Ghost preview">
        <GhostCard />
      </Labeled>
      <Labeled label="B. Ghost preview + invitation">
        <GhostInviteCard />
      </Labeled>
      <Labeled label="C. Shapes only + invitation">
        <SkeletonInviteCard />
      </Labeled>
      <Labeled label="Populated (reference)">
        <PopulatedCard />
      </Labeled>
    </Bench>
  ),
};

/** The same comparison over a character-tinted card, as in the screenshot. */
export const ComparisonTinted: Story = {
  render: () => (
    <Bench tint>
      <Labeled label="Today">
        <CurrentCard />
      </Labeled>
      <Labeled label="A. Ghost preview">
        <GhostCard />
      </Labeled>
      <Labeled label="B. Ghost preview + invitation">
        <GhostInviteCard />
      </Labeled>
      <Labeled label="C. Shapes only + invitation">
        <SkeletonInviteCard />
      </Labeled>
    </Bench>
  ),
};
