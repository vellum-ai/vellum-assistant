/**
 * Tests for the `AppearanceCard` theme picker.
 *
 * The card renders on every platform, so no Electron/pointer probes are needed.
 * `SegmentControl` is stubbed with a minimal harness exposing its `onChange`
 * via buttons; the theme persistence helpers and the device-setting watcher are
 * mocked.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const applyThemePreferenceMock = mock((_theme: string) => {});
const writeStoredThemePreferenceMock = mock((_theme: string) => {});
const readStoredThemePreferenceMock = mock(() => "system" as const);

mock.module("@/domains/settings/utils/theme-preferences", () => ({
  applyThemePreference: applyThemePreferenceMock,
  readStoredThemePreference: readStoredThemePreferenceMock,
  writeStoredThemePreference: writeStoredThemePreferenceMock,
}));

mock.module("@/utils/device-settings", () => ({
  watchDeviceSetting: () => () => {},
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
    applyThemePreferenceMock.mockClear();
    writeStoredThemePreferenceMock.mockClear();
    readStoredThemePreferenceMock.mockClear();
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

  test("choosing a theme writes and applies it", () => {
    render(<AppearanceCard />);

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(writeStoredThemePreferenceMock).toHaveBeenCalledWith("dark");
    expect(applyThemePreferenceMock).toHaveBeenCalledWith("dark");
  });

  test("exposes the Velvet option when the flag is enabled", () => {
    velvetValue.current = true;
    render(<AppearanceCard />);

    expect(screen.getByRole("button", { name: "Velvet" })).toBeDefined();
  });
});
