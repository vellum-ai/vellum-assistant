/**
 * Tests for the Plugins `FilterBar`. Mounted via `@testing-library/react`
 * (happy-dom — see `clients/web/test-setup.ts`). The design-library
 * `Popover` is a real Radix portal here; clicking the filter button opens
 * the Status listbox into `document.body`, where we query its options. On
 * mobile the same button opens a `BottomSheet` that also exposes Categories.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { PluginFilter } from "@/domains/intelligence/plugins/types.js";
import { FilterBar } from "@/domains/intelligence/components/plugins/plugin-filters.js";
import type { CategoryInfo } from "@/domains/intelligence/skills/use-skill-categories.js";

afterEach(() => {
  cleanup();
});

const CATEGORIES: CategoryInfo[] = [
  { slug: "email", label: "Email", description: "Email tools", icon: "mail" },
  { slug: "system", label: "System", description: "System tools", icon: "settings" },
];

/** Required `FilterBar` props with inert defaults each test can override. */
function baseProps() {
  return {
    search: "",
    onSearchChange: () => {},
    filter: "all" as PluginFilter,
    onFilterChange: () => {},
    categories: [] as CategoryInfo[],
    category: null,
    onCategoryChange: () => {},
    counts: {} as Record<string, number>,
    totalCount: 0,
    showCounts: true,
    pluginToggleSupported: true,
  };
}

/** Click the Status option whose visible label matches. */
function clickStatusOption(label: string): void {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === label);
  if (!option) {
    throw new Error(
      `expected a "${label}" status option — saw: ${Array.from(
        document.querySelectorAll('[role="option"]'),
      )
        .map((o) => `"${o.textContent?.trim()}"`)
        .join(", ")}`,
    );
  }
  fireEvent.click(option);
}

/**
 * Force `useIsMobile` true so the filter button opens the BottomSheet (the
 * mobile category surface) instead of the desktop Status popover. Returns a
 * restore fn the caller invokes once done.
 */
function forceMobile(): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

describe("Plugins FilterBar", () => {
  test("typing in the search input reports the new value", () => {
    const onSearchChange = mock((_value: string) => {});
    const { getByLabelText } = render(
      <FilterBar {...baseProps()} onSearchChange={onSearchChange} />,
    );

    fireEvent.change(getByLabelText("Search plugins"), {
      target: { value: "memory" },
    });

    expect(onSearchChange).toHaveBeenCalledWith("memory");
  });

  test("opening the filter and choosing Active switches the filter", () => {
    const onFilterChange = mock((_filter: PluginFilter) => {});
    const { getByLabelText } = render(
      <FilterBar {...baseProps()} onFilterChange={onFilterChange} />,
    );

    fireEvent.click(getByLabelText("Filter plugins"));
    clickStatusOption("Active");

    expect(onFilterChange).toHaveBeenCalledWith("active");
  });

  test("omits Active/Off when the daemon lacks enable/disable support", () => {
    const { getByLabelText } = render(
      <FilterBar {...baseProps()} pluginToggleSupported={false} />,
    );

    fireEvent.click(getByLabelText("Filter plugins"));

    const labels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((o) => o.textContent?.trim());
    expect(labels).toEqual(["All", "Available"]);
  });

  test("the mobile sheet exposes category rows that report the selected slug", async () => {
    const onCategoryChange = mock((_category: string | null) => {});
    const restoreMatchMedia = forceMobile();
    try {
      const { getByLabelText } = render(
        <FilterBar
          {...baseProps()}
          categories={CATEGORIES}
          counts={{ email: 2, system: 1 }}
          totalCount={3}
          onCategoryChange={onCategoryChange}
        />,
      );

      fireEvent.click(getByLabelText("Filter plugins"));

      const sheet = await screen.findByRole("dialog");
      expect(within(sheet).getByText("Categories")).toBeTruthy();
      const emailRow = within(sheet).getByText("Email");
      expect(within(sheet).getByText("System")).toBeTruthy();

      fireEvent.click(emailRow);
      expect(onCategoryChange).toHaveBeenCalledWith("email");
    } finally {
      restoreMatchMedia();
    }
  });

  test("the mobile sheet omits Categories when no categories are available", async () => {
    const restoreMatchMedia = forceMobile();
    try {
      const { getByLabelText } = render(<FilterBar {...baseProps()} />);

      fireEvent.click(getByLabelText("Filter plugins"));

      const sheet = await screen.findByRole("dialog");
      expect(within(sheet).getByText("Status")).toBeTruthy();
      expect(within(sheet).queryByText("Categories")).toBeNull();
    } finally {
      restoreMatchMedia();
    }
  });
});
