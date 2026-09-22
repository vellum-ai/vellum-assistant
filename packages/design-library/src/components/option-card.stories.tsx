import type { Meta, StoryObj } from "@storybook/react-vite";
import { Calendar, Loader2, Mail, MessageSquare, Plane } from "lucide-react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";

import { OptionCard, OptionCardGroup } from "./option-card";

const meta: Meta<typeof OptionCard> = {
  title: "Components/OptionCard",
  component: OptionCard,
  args: {
    title: "Clean up my inbox",
    description: "Archive newsletters and flag what needs a reply.",
    selected: false,
    selectionMode: "single",
    variant: "outlined",
    orientation: "horizontal",
    size: "regular",
    markPosition: "start",
    hideMark: false,
    disabled: false,
  },
  argTypes: {
    selectionMode: {
      control: "inline-radio",
      options: ["single", "multiple"],
    },
    variant: { control: "inline-radio", options: ["outlined", "filled"] },
    orientation: {
      control: "inline-radio",
      options: ["horizontal", "vertical"],
    },
    size: { control: "inline-radio", options: ["regular", "compact"] },
    markPosition: { control: "inline-radio", options: ["start", "end"] },
    leading: { control: false },
    trailing: { control: false },
    onSelect: { control: false },
    ref: { control: false },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 384 }}>
        <Story />
      </div>
    ),
  ],
  // `selected` is controlled; drive it from the arg and write it back so the
  // Controls panel and the canvas stay in sync.
  render: function Render(args) {
    const [{ selected }, updateArgs] = useArgs();
    return (
      <OptionCard
        {...args}
        selected={selected}
        onSelect={() => updateArgs({ selected: !selected })}
      />
    );
  },
};

export default meta;

type Story = StoryObj<typeof OptionCard>;

/** Arg-driven: flip the mode, variant, layout and state in Controls. */
export const Default: Story = {};

/** A `leading` icon sits between the mark and the text. */
export const WithLeadingIcon: Story = {
  args: { leading: <Mail className="h-4 w-4" />, selectionMode: "multiple" },
};

/** Disabled blocks selection and drops the hover fill. */
export const Disabled: Story = {
  args: { disabled: true, selected: true },
};

const PLANS = [
  { id: "free", title: "Free", description: "One assistant, community support." },
  { id: "pro", title: "Pro", description: "Unlimited assistants and schedules." },
  { id: "team", title: "Team", description: "Shared workspaces and admin roles." },
];

/**
 * A radio group. Owns its state locally (a `useArgs` story cannot assert its
 * own transitions). Tab lands on the checked card; arrow keys move focus and
 * select.
 */
export const SingleSelect: Story = {
  parameters: { controls: { disable: true } },
  render: function Render() {
    const [value, setValue] = useState("pro");
    return (
      <OptionCardGroup selectionMode="single" aria-label="Plan">
        {PLANS.map((plan) => (
          <OptionCard
            key={plan.id}
            title={plan.title}
            description={plan.description}
            selected={value === plan.id}
            onSelect={() => setValue(plan.id)}
          />
        ))}
      </OptionCardGroup>
    );
  },
};

const TASKS = [
  { id: "email", title: "Email", description: "Triage and draft replies", icon: Mail },
  { id: "calendar", title: "Calendar", description: "Plan and reschedule", icon: Calendar },
  { id: "travel", title: "Travel", description: "Book and track trips", icon: Plane },
  { id: "other", title: "Other", description: "Something else", icon: MessageSquare },
];

function useToggleSet(initial: string[]) {
  const [selected, setSelected] = useState(() => new Set(initial));
  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  return [selected, toggle] as const;
}

/** A checkbox group: every card is its own tab stop and toggles on its own. */
export const MultiSelect: Story = {
  parameters: { controls: { disable: true } },
  render: function Render() {
    const [selected, toggle] = useToggleSet(["email"]);
    return (
      <OptionCardGroup selectionMode="multiple" aria-label="Tasks">
        {TASKS.map((task) => (
          <OptionCard
            key={task.id}
            title={task.title}
            description={task.description}
            leading={<task.icon className="h-4 w-4" />}
            selected={selected.has(task.id)}
            onSelect={() => toggle(task.id)}
          />
        ))}
      </OptionCardGroup>
    );
  },
};

/**
 * `columns={2}` with compact, vertical tiles: the icon and the mark share the
 * top row and the text sits beneath, which is what fits a narrow tile.
 */
export const TwoColumnGrid: Story = {
  parameters: { controls: { disable: true } },
  render: function Render() {
    const [selected, toggle] = useToggleSet(["calendar"]);
    return (
      <OptionCardGroup selectionMode="multiple" columns={2} aria-label="Tasks">
        {TASKS.map((task) => (
          <OptionCard
            key={task.id}
            orientation="vertical"
            size="compact"
            markPosition="end"
            title={task.title}
            description={task.description}
            leading={<task.icon className="h-4 w-4" />}
            selected={selected.has(task.id)}
            onSelect={() => toggle(task.id)}
          />
        ))}
      </OptionCardGroup>
    );
  },
};

/**
 * `variant="filled"` with `selectOnFocus={false}`: borderless rows for a
 * surface where choosing commits at once. Arrow keys only move focus, so a
 * keyboard user can reach the last option before anything is submitted.
 */
export const FilledCommitOnSelect: Story = {
  parameters: { controls: { disable: true } },
  render: function Render() {
    const [value, setValue] = useState<string | null>(null);
    return (
      <OptionCardGroup
        selectionMode="single"
        selectOnFocus={false}
        disabled={value !== null}
        aria-label="Plan"
      >
        {PLANS.map((plan) => (
          <OptionCard
            key={plan.id}
            variant="filled"
            title={plan.title}
            description={plan.description}
            selected={value === plan.id}
            trailing={
              value === plan.id ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : undefined
            }
            onSelect={() => setValue(plan.id)}
          />
        ))}
      </OptionCardGroup>
    );
  },
};

/** Every state of both marks and both variants, side by side. */
export const AllStates: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div style={{ display: "grid", gap: 16 }}>
      {(["outlined", "filled"] as const).map((variant) =>
        (["single", "multiple"] as const).map((selectionMode) => (
          <OptionCardGroup
            key={`${variant}-${selectionMode}`}
            selectionMode={selectionMode}
            aria-label={`${variant} ${selectionMode}`}
          >
            <OptionCard variant={variant} selected={false} title="Unselected" />
            <OptionCard variant={variant} selected title="Selected" />
            <OptionCard
              variant={variant}
              selected={false}
              disabled
              title="Disabled"
            />
            <OptionCard
              variant={variant}
              selected
              disabled
              title="Disabled and selected"
            />
          </OptionCardGroup>
        )),
      )}
    </div>
  ),
};

/** Mark at either end, and no mark at all. */
export const MarkPlacement: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <OptionCardGroup selectionMode="multiple" aria-label="Mark placement">
      <OptionCard selected markPosition="start" title="Mark at the start" />
      <OptionCard selected markPosition="end" title="Mark at the end" />
      <OptionCard selected hideMark title="No mark" />
    </OptionCardGroup>
  ),
};
