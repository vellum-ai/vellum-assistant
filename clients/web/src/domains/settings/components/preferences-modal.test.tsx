/**
 * Tests for `PreferencesModal`, focused on the Appearance section that was
 * migrated in from the standalone Settings → General "Appearance" card.
 *
 * The migration's behavior change is that Appearance now renders on every
 * platform (not just Electron), which is what gives the modal meaningful
 * content on web/iOS. These tests mount the modal as a web (non-Electron)
 * client and assert: (1) the Appearance section renders with a theme control,
 * and (2) choosing a theme writes and applies it. `SegmentControl` is stubbed
 * with a minimal harness exposing its `onChange` via buttons; the theme
 * persistence helpers and the Electron probe are mocked.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
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

// Web client: not Electron. Keyboard Shortcuts + Launch at Login stay hidden,
// leaving Appearance (+ the composer toggle) as the modal's content.
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => false,
}));

// Desktop-width pointer so the composer section is not force-nulled; keeps the
// test independent of that section while exercising the always-on Appearance.
mock.module("@/utils/pointer", () => ({
  isPointerCoarse: () => false,
}));

mock.module("@/domains/settings/keyboard-shortcuts/shortcuts-sections", () => ({
  ShortcutsSections: () => null,
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

import { PreferencesModal } from "@/domains/settings/components/preferences-modal";

describe("PreferencesModal — Appearance section", () => {
  beforeEach(() => {
    applyThemePreferenceMock.mockClear();
    writeStoredThemePreferenceMock.mockClear();
    readStoredThemePreferenceMock.mockClear();
    velvetValue.current = false;
  });

  afterEach(() => {
    cleanup();
  });

  test("renders the Appearance section with theme options on web", () => {
    render(<PreferencesModal open onClose={() => {}} />);

    expect(screen.getByText("Appearance")).toBeDefined();
    expect(screen.getByLabelText("Theme")).toBeDefined();
    expect(screen.getByRole("button", { name: "System" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Light" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Dark" })).toBeDefined();
    // Velvet is gated behind the flag (off here).
    expect(screen.queryByRole("button", { name: "Velvet" })).toBeNull();
  });

  test("choosing a theme writes and applies it", () => {
    render(<PreferencesModal open onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(writeStoredThemePreferenceMock).toHaveBeenCalledWith("dark");
    expect(applyThemePreferenceMock).toHaveBeenCalledWith("dark");
  });

  test("exposes the Velvet option when the flag is enabled", () => {
    velvetValue.current = true;
    render(<PreferencesModal open onClose={() => {}} />);

    expect(screen.getByRole("button", { name: "Velvet" })).toBeDefined();
  });
});
