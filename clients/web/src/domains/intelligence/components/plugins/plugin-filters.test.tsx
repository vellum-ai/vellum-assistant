/**
 * Tests for the Plugins `FilterBar`. Mounted via `@testing-library/react`
 * (happy-dom — see `clients/web/test-setup.ts`). The design-library
 * `Popover` is a real Radix portal here; clicking the filter button opens
 * the Status listbox into `document.body`, where we query its options.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { PluginFilter } from "@/domains/intelligence/plugins/types.js";
import { FilterBar } from "@/domains/intelligence/components/plugins/plugin-filters.js";

afterEach(() => {
  cleanup();
});

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

describe("Plugins FilterBar", () => {
  test("typing in the search input reports the new value", () => {
    const onSearchChange = mock((_value: string) => {});
    const { getByLabelText } = render(
      <FilterBar
        searchValue=""
        onSearchChange={onSearchChange}
        filter="all"
        onFilterChange={() => {}}
      />,
    );

    fireEvent.change(getByLabelText("Search plugins"), {
      target: { value: "memory" },
    });

    expect(onSearchChange).toHaveBeenCalledWith("memory");
  });

  test("opening the filter and choosing Installed switches the filter", () => {
    const onFilterChange = mock((_filter: PluginFilter) => {});
    const { getByLabelText } = render(
      <FilterBar
        searchValue=""
        onSearchChange={() => {}}
        filter="all"
        onFilterChange={onFilterChange}
      />,
    );

    fireEvent.click(getByLabelText("Filter plugins"));
    clickStatusOption("Installed");

    expect(onFilterChange).toHaveBeenCalledWith("installed");
  });
});
