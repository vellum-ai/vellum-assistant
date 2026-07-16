/**
 * Tests for `PreferencesModal`.
 *
 * The theme picker is a separate `AppearanceCard` on Settings → General (see
 * `appearance-card.test.tsx`), not part of this modal. These tests mount the
 * modal as a web (non-Electron) client and assert it hosts the composer send
 * toggle but no Appearance/theme control.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

// Web client: not Electron. Keyboard Shortcuts + Launch at Login stay hidden.
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
