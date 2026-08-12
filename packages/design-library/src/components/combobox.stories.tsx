import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import { expect, screen, userEvent, waitFor } from "storybook/test";

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
 *
 * Dropping the query on close is the caller's call, not the primitive's, and
 * this is how a caller makes it: the pattern leaves clearing an editable
 * combobox optional, so `onOpenChange` is where a search field that should
 * come back empty says so. `TimezonePicker` does exactly this.
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
          onSelect={setCity}
          onOpenChange={(open) => {
            if (!open) {
              setQuery("");
            }
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

/** The field the interaction stories below drive. */
function cityField(): HTMLElement {
  return screen.getByRole("combobox", { name: "Search cities" });
}

/**
 * A query that matches nothing is still a popup: the listbox stays mounted
 * with its empty state, so the field's `aria-expanded` and `aria-controls`
 * describe something that exists, and Escape still closes it.
 *
 * The regression this pins: gating the list on having rows, which leaves the
 * field pointing at an id that was never rendered, and guarding the whole key
 * handler on a non-empty list, which swallows Escape.
 */
export const NoMatchesStaysDismissable: Story = {
  ...Popup,
  play: async () => {
    const field = cityField();
    await userEvent.click(field);
    await userEvent.type(field, "zzzz");

    const list = await screen.findByRole("listbox", { name: "Cities" });
    expect(list).toHaveTextContent("No matching cities");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    // The relationship the field advertises has to resolve to this element.
    expect(field).toHaveAttribute("aria-expanded", "true");
    expect(field).toHaveAttribute("aria-controls", list.id);

    await userEvent.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
    expect(field).toHaveAttribute("aria-expanded", "false");
    expect(field).not.toHaveAttribute("aria-controls");
    expect(field).toHaveFocus();
    // The close was reported, so a caller that clears its query on close (as
    // `TimezonePicker` does, and this story's `onOpenChange`) still gets to.
    expect(field).toHaveValue("");
  },
};

/**
 * Filtering a list is silent to anyone who cannot see it, so the live region
 * reports the new size. It reports a change, not a keystroke: typing that
 * leaves the count alone says nothing.
 */
export const FilteringAnnouncesTheCount: Story = {
  ...Popup,
  play: async () => {
    const field = cityField();
    const status = () => screen.getByRole("status");

    await userEvent.click(field);
    await waitFor(() => {
      expect(status()).toHaveTextContent(`${CITIES.length} results are`);
    });

    await userEvent.type(field, "lon");
    await waitFor(() => {
      expect(status()).toHaveTextContent("1 result is available");
    });

    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(status()).toBeEmptyDOMElement();
    });
  },
};

/**
 * Closing takes the highlight with it: an `aria-activedescendant` left behind
 * names an option that unmounted with the list.
 */
export const DismissClearsTheHighlight: Story = {
  ...Popup,
  play: async () => {
    const field = cityField();
    await userEvent.click(field);
    await userEvent.type(field, "lon");
    await userEvent.keyboard("{ArrowDown}");

    const active = field.getAttribute("aria-activedescendant");
    expect(active).not.toBeNull();
    // Pointing at a real option is what makes clearing it meaningful.
    expect(document.getElementById(active!)).toHaveAttribute("role", "option");

    await userEvent.keyboard("{Escape}");

    await waitFor(() => {
      expect(field).not.toHaveAttribute("aria-activedescendant");
    });
  },
};

/**
 * Home and End belong to the text cursor in an editable combobox, so they
 * must not move the option highlight.
 *
 * @see https://www.w3.org/WAI/ARIA/apg/patterns/combobox/
 */
export const HomeAndEndEditTheQuery: Story = {
  ...Popup,
  play: async () => {
    const field = cityField();
    await userEvent.click(field);
    await userEvent.type(field, "lon");
    await userEvent.keyboard("{ArrowDown}");
    const active = field.getAttribute("aria-activedescendant");

    await userEvent.keyboard("{Home}");
    expect(field).toHaveAttribute("aria-activedescendant", active!);
    await userEvent.keyboard("{End}");
    expect(field).toHaveAttribute("aria-activedescendant", active!);

    // The keys reached the input instead: typing lands where the cursor is.
    await userEvent.keyboard("{Home}g");
    expect(field).toHaveValue("glon");
  },
};
