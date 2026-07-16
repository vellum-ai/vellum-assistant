/**
 * Tests for `PreferencesModal`.
 *
 * The theme picker lives inline in the Preferences card on Settings → General
 * (see `theme-picker.test.tsx`), not in this modal. These tests mount the
 * modal as a web (non-Electron) client and assert it hosts the composer send
 * toggle but no Appearance/theme control.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

const applyThemePreferenceMock = mock((_theme: string) => {});
const writeStoredThemePreferenceMock = mock((_theme: string) => {});
const readStoredThemePreferenceMock = mock(() => "system" as const);

mock.module("@/utils/theme-preferences", () => ({
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

// Fine pointer so the composer section renders (it is force-nulled on touch).
mock.module("@/utils/pointer", () => ({
  isPointerCoarse: () => false,
}));

mock.module("@/runtime/platform-detection", () => ({
  isMacOSBrowser: () => true,
}));

mock.module("@/utils/composer-settings", () => ({
  cmdEnterToSend: {
    useValue: () => false,
    save: () => {},
  },
}));

mock.module("@/domains/settings/keyboard-shortcuts/shortcuts-sections", () => ({
  ShortcutsSections: () => null,
}));

mock.module("@/runtime/launch-at-login", () => ({
  getLaunchAtLogin: () => Promise.resolve(false),
  setLaunchAtLogin: () => Promise.resolve(),
}));

import { PreferencesModal } from "@/domains/settings/components/preferences-modal";

describe("PreferencesModal", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders the composer send toggle on web", () => {
    render(<PreferencesModal open onClose={() => {}} />);

    expect(screen.getByText("Composer")).toBeDefined();
    expect(screen.getByText("Send with Cmd+Enter")).toBeDefined();
  });

  test("does not host the Appearance theme picker", () => {
    render(<PreferencesModal open onClose={() => {}} />);

    expect(screen.queryByText("Appearance")).toBeNull();
    expect(screen.queryByLabelText("Theme")).toBeNull();
  });
});
