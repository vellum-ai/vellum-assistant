/**
 * Tests for the `AppearanceCard` theme picker.
 *
 * The card renders on every platform. `useThemePreference` and `SegmentControl`
 * are stubbed so the test exercises the card's option list and its delegation to
 * the shared theme setter.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const setThemePreferenceMock = mock((_theme: string) => {});

mock.module("@/hooks/use-theme-preference", () => ({
  useThemePreference: () => ({
    theme: "system",
    setThemePreference: setThemePreferenceMock,
  }),
}));

// Minimal SegmentControl harness: render one button per item exposing onChange.
mock.module("@vellumai/design-library/components/segment-control", () => ({
  SegmentControl: ({
    items,
    onChange,
    ariaLabel,
  }: {
    items: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
    ariaLabel: string;
  }) => (
    <div aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

// Feature-flag store: `velvet` off so the theme list is System/Light/Dark.
const velvetValue = { current: false };
mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: {
      velvet: () => velvetValue.current,
    },
  },
}));

import { AppearanceCard } from "@/domains/settings/components/appearance-card";

describe("AppearanceCard", () => {
  beforeEach(() => {
    setThemePreferenceMock.mockClear();
    velvetValue.current = false;
  });

  afterEach(() => {
    cleanup();
  });

  test("renders the Appearance card with theme options", () => {
    render(<AppearanceCard />);

    expect(screen.getByText("Appearance")).toBeDefined();
    expect(screen.getByLabelText("Theme")).toBeDefined();
    expect(screen.getByRole("button", { name: "System" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Light" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Dark" })).toBeDefined();
    // Velvet is gated behind the flag (off here).
    expect(screen.queryByRole("button", { name: "Velvet" })).toBeNull();
  });

  test("choosing a theme delegates to the shared theme setter", () => {
    render(<AppearanceCard />);

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(setThemePreferenceMock).toHaveBeenCalledWith("dark");
  });

  test("exposes the Velvet option when the flag is enabled", () => {
    velvetValue.current = true;
    render(<AppearanceCard />);

    expect(screen.getByRole("button", { name: "Velvet" })).toBeDefined();
  });
});
