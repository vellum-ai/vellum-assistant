import { Heart, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { ShortcutsSections } from "@/domains/settings/keyboard-shortcuts/shortcuts-sections";
import { isElectron } from "@/runtime/is-electron";
import { getLaunchAtLogin, setLaunchAtLogin } from "@/runtime/launch-at-login";
import { isMacOSBrowser } from "@/runtime/platform-detection";
import { cmdEnterToSend } from "@/utils/composer-settings";
import { isPointerCoarse } from "@/utils/pointer";
import {
  applyThemePreference,
  readStoredThemePreference,
  type ThemePreference,
  writeStoredThemePreference,
} from "@/domains/settings/utils/theme-preferences";
import { watchDeviceSetting } from "@/utils/device-settings";
import { Modal } from "@vellumai/design-library/components/modal";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";
import { Toggle } from "@vellumai/design-library/components/toggle";

/**
 * Theme picker (System / Light / Dark, plus Velvet when the flag is on).
 * Lives in Preferences alongside the other per-device preferences. Unlike the
 * other sections it is not Electron-gated — theme applies on every platform —
 * so it also gives the modal meaningful content on web and iOS.
 */
function AppearanceSection() {
  const velvet = useClientFeatureFlagStore.use.velvet();
  const [theme, setTheme] = useState<ThemePreference>(() =>
    readStoredThemePreference({ velvetEnabled: velvet }),
  );

  useEffect(() => {
    setTheme(readStoredThemePreference({ velvetEnabled: velvet }));
  }, [velvet]);

  useEffect(() => {
    return watchDeviceSetting("theme", () => {
      setTheme(readStoredThemePreference({ velvetEnabled: velvet }));
    });
  }, [velvet]);

  useEffect(() => {
    applyThemePreference(theme);
  }, [theme]);

  const handleThemeChange = (newTheme: ThemePreference) => {
    setTheme(newTheme);
    writeStoredThemePreference(newTheme);
    applyThemePreference(newTheme);
  };

  const themeItems = [
    {
      value: "system" as const,
      label: "System",
      icon: <Monitor className="h-4 w-4" />,
    },
    {
      value: "light" as const,
      label: "Light",
      icon: <Sun className="h-4 w-4" />,
    },
    {
      value: "dark" as const,
      label: "Dark",
      icon: <Moon className="h-4 w-4" />,
    },
    ...(velvet
      ? [
          {
            value: "velvet" as const,
            label: "Velvet",
            icon: <Heart className="h-4 w-4" />,
          },
        ]
      : []),
  ];

  return (
    <section>
      <h3 className="text-title-small text-[var(--content-emphasised)]">
        Appearance
      </h3>
      <div className="mt-2 max-w-[360px]">
        <SegmentControl<ThemePreference>
          ariaLabel="Theme"
          value={theme}
          onChange={handleThemeChange}
          items={themeItems}
        />
      </div>
    </section>
  );
}

/**
 * Preferences section for the composer's Enter-key behavior, at parity with
 * the macOS app's "Send with Cmd+Enter" toggle.
 */
function ComposerSendSection() {
  const enabled = cmdEnterToSend.useValue();

  // On touch devices the composer never submits on Enter (it always inserts
  // a newline; sending happens via the send button), so the toggle would be
  // a no-op control.
  if (isPointerCoarse()) {
    return null;
  }

  const modifier = isMacOSBrowser() ? "Cmd" : "Ctrl";

  return (
    <section>
      <h3 className="text-title-small text-[var(--content-emphasised)]">
        Composer
      </h3>
      <div className="mt-2">
        <Toggle
          checked={enabled}
          onChange={cmdEnterToSend.save}
          label={`Send with ${modifier}+Enter`}
          helperText={`When enabled, Enter inserts a new line and ${modifier}+Enter sends.`}
        />
      </div>
    </section>
  );
}

/** Electron-only toggle for launching the app when the user logs in. */
function LaunchAtLoginSection() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    getLaunchAtLogin().then(setEnabled);
  }, []);

  const handleToggle = async (next: boolean) => {
    setEnabled(next);
    try {
      await setLaunchAtLogin(next);
    } catch {
      setEnabled(!next);
    }
  };

  return (
    <section>
      <h3 className="text-title-small text-[var(--content-emphasised)]">
        Launch at Login
      </h3>
      <p className="text-body-medium-default text-[var(--content-tertiary)]">
        Automatically start Vellum when you log in to your Mac.
      </p>
      <div className="mt-2">
        <Toggle
          checked={enabled}
          onChange={(next) => void handleToggle(next)}
          aria-label="Launch at Login"
        />
      </div>
    </section>
  );
}

export interface PreferencesModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Preferences editor opened from the Preferences card on Settings → General.
 * Hosts the appearance/theme picker (all platforms), the shortcut rebinding
 * sections (Electron only — hotkeys drive Electron globalShortcut + menu
 * accelerators with no web/iOS analogue), the composer send toggle, and the
 * Launch at Login toggle.
 */
export function PreferencesModal({ open, onClose }: PreferencesModalProps) {
  return (
    <Modal.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose();
        }
      }}
    >
      <Modal.Content size="lg">
        <Modal.Header>
          <Modal.Title>Preferences</Modal.Title>
          <Modal.Description>
            Customize shortcuts and how Vellum behaves on this device.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <div className="space-y-6">
            <AppearanceSection />
            {isElectron() && (
              <section>
                <h3 className="text-title-small text-[var(--content-emphasised)]">
                  Keyboard Shortcuts
                </h3>
                <p className="text-body-medium-default text-[var(--content-tertiary)]">
                  Customize the shortcuts for Vellum&apos;s commands.
                </p>
                <div className="mt-2">
                  <ShortcutsSections />
                </div>
              </section>
            )}
            <ComposerSendSection />
            {isElectron() && <LaunchAtLoginSection />}
          </div>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
