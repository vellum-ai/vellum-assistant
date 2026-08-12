import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";

import { Combobox } from "./combobox";

const CITIES = [
  "Amsterdam",
  "Auckland",
  "Bangkok",
  "Berlin",
  "Buenos Aires",
  "Cairo",
  "Chicago",
  "Dublin",
  "Istanbul",
  "Johannesburg",
  "Lagos",
  "Lisbon",
  "London",
  "Los Angeles",
  "Madrid",
  "Melbourne",
  "Mexico City",
  "Mumbai",
  "Nairobi",
  "New York",
  "Paris",
  "São Paulo",
  "Seoul",
  "Singapore",
  "Stockholm",
  "Sydney",
  "Tokyo",
  "Toronto",
  "Vancouver",
  "Zurich",
];

const FEATURED = ["London", "New York", "Tokyo"];

const OPTION_CLASS = [
  "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2",
  "text-body-medium-default text-[var(--content-default)]",
  "hover:bg-[var(--surface-hover)]",
  "data-[active]:bg-[var(--surface-hover)]",
  "aria-selected:bg-[var(--surface-active)]",
].join(" ");

function matches(city: string, query: string): boolean {
  return city.toLowerCase().includes(query.trim().toLowerCase());
}

/**
 * A text field that filters a list, with the keyboard contract the `combobox`
 * role promises: focus stays in the field, ArrowDown/ArrowUp/Home/End move the
 * highlight, Enter commits it, Escape closes the list.
 *
 * Both stories own the query and the selection locally, so the keyboard can be
 * tried directly in the canvas; every other `Root` prop comes from args, so
 * `autoActivateFirst` and the inline/popup shape are Controls.
 */
const meta: Meta<typeof Combobox.Root> = {
  title: "Components/Combobox",
  component: Combobox.Root,
  args: {
    autoActivateFirst: true,
  },
  argTypes: {
    options: { control: false },
    value: { control: false },
    onSelect: { control: false },
    onOpenChange: { control: false },
    children: { control: false },
    open: { control: "boolean" },
  },
  decorators: [
    (Story) => (
      <div className="w-[320px] p-6">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof Combobox.Root>;

/**
 * The popup shape: no `open` prop, so the list opens on focus and closes on
 * Escape, a press outside, or a pick.
 */
export const Popup: Story = {
  render: function Render(args) {
    const [query, setQuery] = useState("");
    const [city, setCity] = useState("London");
    const filtered = useMemo(
      () => CITIES.filter((option) => matches(option, query)),
      [query],
    );

    return (
      <div className="flex flex-col gap-3">
        <Combobox.Root
          {...args}
          options={filtered}
          value={city}
          onSelect={(next) => {
            setCity(next);
            setQuery("");
          }}
        >
          <Combobox.Input
            aria-label="Search cities"
            placeholder={city}
            leftIcon={<Search className="size-4" />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            fullWidth
          />
          <Combobox.List
            aria-label="Cities"
            className="absolute inset-x-0 top-full z-20 mt-1 max-h-60 rounded-md border border-[var(--border-base)] bg-[var(--surface-lift)] p-1 shadow-[var(--shadow-popover)]"
            emptyState={
              <p className="px-3 py-2 text-body-medium-lighter text-[var(--content-tertiary)]">
                No matching cities
              </p>
            }
          >
            {filtered.map((option) => (
              <Combobox.Option
                key={option}
                value={option}
                className={OPTION_CLASS}
              >
                {option}
                {option === city && (
                  <Check
                    aria-hidden
                    className="size-4 text-[var(--system-positive-strong)]"
                  />
                )}
              </Combobox.Option>
            ))}
          </Combobox.List>
        </Combobox.Root>
        <span className="text-body-small-default text-[var(--content-tertiary)]">
          {city}
        </span>
      </div>
    );
  },
};

/**
 * The inline shape: `open` is pinned on, so the list is always on screen and
 * Escape belongs to whatever hosts it. Grouped, the way a picker with a
 * pinned section renders.
 */
export const InlineGrouped: Story = {
  args: { open: true },
  render: function Render(args) {
    const [query, setQuery] = useState("");
    const [city, setCity] = useState("Tokyo");
    const filtering = query.trim().length > 0;
    const rest = useMemo(
      () => CITIES.filter((option) => !FEATURED.includes(option)),
      [],
    );
    const visible = useMemo(
      () =>
        [...FEATURED, ...rest].filter(
          (option) => !filtering || matches(option, query),
        ),
      [rest, filtering, query],
    );

    const option = (value: string) => (
      <Combobox.Option key={value} value={value} className={OPTION_CLASS}>
        {value}
        {value === city && (
          <Check
            aria-hidden
            className="size-4 text-[var(--system-positive-strong)]"
          />
        )}
      </Combobox.Option>
    );

    return (
      <div className="flex flex-col gap-2">
        <Combobox.Root
          {...args}
          options={visible}
          value={city}
          onSelect={setCity}
        >
          <Combobox.Input
            aria-label="Search cities"
            placeholder="Search cities"
            leftIcon={<Search className="size-4" />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            fullWidth
          />
          <Combobox.List
            aria-label="Cities"
            className="mt-2 max-h-60"
            emptyState={
              <p className="px-3 py-2 text-body-medium-lighter text-[var(--content-tertiary)]">
                No matching cities
              </p>
            }
          >
            {filtering ? (
              visible.map(option)
            ) : (
              <>
                <Combobox.Group label="Featured">
                  {FEATURED.map(option)}
                </Combobox.Group>
                <Combobox.Group label="All cities">
                  {rest.map(option)}
                </Combobox.Group>
              </>
            )}
          </Combobox.List>
        </Combobox.Root>
      </div>
    );
  },
};
