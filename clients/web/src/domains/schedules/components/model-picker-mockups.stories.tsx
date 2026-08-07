import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";

import { Menu } from "@vellumai/design-library/components/menu";
import { Select } from "@vellumai/design-library/components/select";
import { Tag } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";

/**
 * Throwaway design exploration for the schedule detail panel's model picker.
 *
 * Not wired to data: every variant renders the same DETAILS card against fixed
 * strings so the options can be compared side by side. Delete once a direction
 * is picked and implemented against `schedule-detail-panel.tsx`.
 */

const PROFILES = ["Balanced", "Fast", "Deep reasoning", "Cost optimized"];

// --- Shared scaffolding, copied from schedule-detail-panel.tsx -------------

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 text-body-small-emphasised uppercase tracking-wide text-[var(--content-tertiary)]">
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-4 py-1">
      <span className="text-body-medium-lighter text-[var(--content-secondary)]">
        {label}
      </span>
      <span className="min-w-0 text-right text-body-medium-lighter text-[var(--content-default)]">
        {value}
      </span>
    </div>
  );
}

function DetailsCard({ modelRow }: { modelRow: ReactNode }) {
  return (
    <section>
      <SectionLabel>Details</SectionLabel>
      <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] px-4 py-2">
        <InfoRow label="Cadence" value="Every day at 4:00 PM" />
        <InfoRow label="Mode" value="Notify" />
        {modelRow}
        <InfoRow label="Status" value="Enabled" />
        <InfoRow label="Next run" value="Aug 8, 4:00 PM" />
      </div>
    </section>
  );
}

/** Panel chrome so each variant is judged at the width it actually ships at. */
function PanelFrame({ children }: { children: ReactNode }) {
  return (
    <div className="w-[420px] rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)]">
      <div className="border-b border-[var(--border-base)] px-4 py-3">
        <Typography variant="title-small">Drink water reminder</Typography>
      </div>
      <div className="space-y-6 p-4">
        <p className="text-body-medium-lighter text-[var(--content-secondary)]">
          Daily reminder to drink 2 liters of water.
        </p>
        {children}
      </div>
    </div>
  );
}

function Caption({ title, note }: { title: string; note: string }) {
  return (
    <div className="mb-3 max-w-[420px]">
      <div className="text-body-medium-emphasised text-[var(--content-default)]">
        {title}
      </div>
      <div className="text-body-small-default text-[var(--content-tertiary)]">
        {note}
      </div>
    </div>
  );
}

// --- Variant triggers ------------------------------------------------------

/**
 * A: value styled exactly like every other row's value, with a chevron. The
 * box appears only on hover/focus, so the row reads as data until aimed at.
 */
function InlineGhostPicker() {
  const [value, setValue] = useState(PROFILES[0]!);
  return (
    <Menu.Root>
      <Menu.Trigger>
        <button
          type="button"
          aria-label="Model profile"
          className="-mr-2 inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-body-medium-lighter text-[var(--content-default)] transition-colors hover:border-[var(--border-base)] hover:bg-[var(--surface-lift-hover,var(--surface-base))] focus-visible:border-[var(--border-base)] focus-visible:outline-none data-[state=open]:border-[var(--border-base)] data-[state=open]:bg-[var(--surface-base)]"
        >
          {value}
          <ChevronDown className="h-3.5 w-3.5 text-[var(--content-tertiary)]" />
        </button>
      </Menu.Trigger>
      <Menu.Content align="end">
        <Menu.RadioGroup value={value} onValueChange={setValue}>
          {PROFILES.map((profile) => (
            <Menu.RadioItem key={profile} value={profile}>
              {profile}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  );
}

/** B: the shipping Select, one size down and shrink-wrapped to its label. */
function CompactSelectPicker() {
  const [value, setValue] = useState(PROFILES[0]!);
  return (
    <Select
      size="compact"
      fullWidth={false}
      value={value}
      onChange={setValue}
      options={PROFILES.map((profile) => ({ value: profile, label: profile }))}
      menuAlign="end"
      aria-label="Model profile"
    />
  );
}

/** D: value as a chip, which reads as a set attribute rather than a form input. */
function TagPicker() {
  const [value, setValue] = useState(PROFILES[0]!);
  return (
    <Menu.Root>
      <Menu.Trigger>
        <button type="button" aria-label="Model profile" className="align-middle">
          <Tag
            rightIcon={<ChevronDown />}
            className="cursor-pointer transition-colors hover:bg-[var(--surface-lift-hover,var(--tag-bg-neutral))]"
          >
            {value}
          </Tag>
        </button>
      </Menu.Trigger>
      <Menu.Content align="end">
        <Menu.RadioGroup value={value} onValueChange={setValue}>
          {PROFILES.map((profile) => (
            <Menu.RadioItem key={profile} value={profile}>
              {profile}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  );
}

/** C: the picker leaves the facts card entirely and becomes its own field. */
function ModelSection() {
  const [value, setValue] = useState(PROFILES[0]!);
  return (
    <section>
      <SectionLabel>Model</SectionLabel>
      <Select
        value={value}
        onChange={setValue}
        options={PROFILES.map((profile) => ({ value: profile, label: profile }))}
        helperText="Applies to every future run of this schedule."
        aria-label="Model profile"
      />
    </section>
  );
}

/** E: segmented list of profiles, each row a full-width choice. */
function ChoiceListSection() {
  const [value, setValue] = useState(PROFILES[0]!);
  return (
    <section>
      <SectionLabel>Model</SectionLabel>
      <div className="overflow-hidden rounded-lg border border-[var(--border-base)]">
        {PROFILES.map((profile, index) => (
          <button
            key={profile}
            type="button"
            onClick={() => setValue(profile)}
            className={[
              "flex w-full items-center justify-between px-4 py-2.5 text-left text-body-medium-lighter transition-colors",
              index > 0 ? "border-t border-[var(--border-base)]" : "",
              profile === value
                ? "bg-[var(--surface-lift)] text-[var(--content-default)]"
                : "text-[var(--content-secondary)] hover:bg-[var(--surface-lift)]",
            ].join(" ")}
          >
            {profile}
            {profile === value ? <Check className="h-4 w-4" /> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

// --- Stories ---------------------------------------------------------------

const meta = {
  title: "Explorations/Schedule model picker",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Current: Story = {
  render: () => (
    <div>
      <Caption
        title="Current"
        note="A 36px bordered input inside a list of plain-text facts. It is the only boxed thing on the card, so it outweighs the schedule's name, and it forces its row taller than its neighbours."
      />
      <PanelFrame>
        <DetailsCard
          modelRow={
            <InfoRow
              label="Model profile"
              value={
                <Select
                  value={PROFILES[0]!}
                  onChange={() => {}}
                  options={PROFILES.map((profile) => ({
                    value: profile,
                    label: profile,
                  }))}
                  aria-label="Model profile"
                  className="min-w-[11rem]"
                />
              }
            />
          }
        />
      </PanelFrame>
    </div>
  ),
};

export const AInlineGhost: Story = {
  render: () => (
    <div>
      <Caption
        title="A. Inline ghost value"
        note="Reads as data, behaves as a control: the chevron marks it editable, the box appears on hover/focus. Same pattern the chat composer already uses for this exact setting."
      />
      <PanelFrame>
        <DetailsCard
          modelRow={<InfoRow label="Model profile" value={<InlineGhostPicker />} />}
        />
      </PanelFrame>
    </div>
  ),
};

export const BCompactSelect: Story = {
  render: () => (
    <div>
      <Caption
        title="B. Compact select"
        note="Smallest possible change: keep the boxed select, drop to 28px and shrink-wrap it. Row rhythm survives, but the card still has exactly one bordered element."
      />
      <PanelFrame>
        <DetailsCard
          modelRow={
            <InfoRow label="Model profile" value={<CompactSelectPicker />} />
          }
        />
      </PanelFrame>
    </div>
  ),
};

export const CSeparateField: Story = {
  render: () => (
    <div>
      <Caption
        title="C. Its own field, outside the facts card"
        note="Details stays read-only. The one editable thing gets a labelled full-width field with room for helper text. Most honest, costs vertical space."
      />
      <PanelFrame>
        <>
          <DetailsCard
            modelRow={<InfoRow label="Model profile" value="Balanced" />}
          />
          <ModelSection />
        </>
      </PanelFrame>
    </div>
  ),
};

export const DTagTrigger: Story = {
  render: () => (
    <div>
      <Caption
        title="D. Chip trigger"
        note="Value as a chip that opens a menu. Light weight, but a chip usually means a status you cannot change, so the affordance is weaker than A."
      />
      <PanelFrame>
        <DetailsCard
          modelRow={<InfoRow label="Model profile" value={<TagPicker />} />}
        />
      </PanelFrame>
    </div>
  ),
};

export const EChoiceList: Story = {
  render: () => (
    <div>
      <Caption
        title="E. Choice list"
        note="No dropdown at all. Best when profiles carry descriptions worth reading, wasteful when there are many or the user rarely changes it."
      />
      <PanelFrame>
        <>
          <DetailsCard
            modelRow={<InfoRow label="Model profile" value="Balanced" />}
          />
          <ChoiceListSection />
        </>
      </PanelFrame>
    </div>
  ),
};

export const SideBySide: Story = {
  render: () => (
    <div className="flex flex-wrap gap-8">
      {(
        [
          ["Current", <Select
            key="cur"
            value={PROFILES[0]!}
            onChange={() => {}}
            options={PROFILES.map((p) => ({ value: p, label: p }))}
            aria-label="Model profile"
            className="min-w-[11rem]"
          />],
          ["A. Inline ghost", <InlineGhostPicker key="a" />],
          ["B. Compact select", <CompactSelectPicker key="b" />],
          ["D. Chip", <TagPicker key="d" />],
        ] as const
      ).map(([title, control]) => (
        <div key={title}>
          <Caption title={title} note="" />
          <PanelFrame>
            <DetailsCard
              modelRow={<InfoRow label="Model profile" value={control} />}
            />
          </PanelFrame>
        </div>
      ))}
    </div>
  ),
};
