import { useEffect, useState } from "react";

import { ShortcutsSections } from "@/domains/settings/keyboard-shortcuts/shortcuts-sections";
import { useTranslation } from "@/i18n";
import { isElectron } from "@/runtime/is-electron";
import { getLaunchAtLogin, setLaunchAtLogin } from "@/runtime/launch-at-login";
import { isMacOSBrowser } from "@/runtime/platform-detection";
import {
  cmdEnterToSend,
  showContextWindowIndicator,
} from "@/utils/composer-settings";
import { isPointerCoarse } from "@/utils/pointer";
import { Modal } from "@vellumai/design-library/components/modal";
import { Toggle } from "@vellumai/design-library/components/toggle";

/**
 * Preferences section for composer behavior: the Enter-key mode (at parity
 * with the macOS app's "Send with Cmd+Enter" toggle) and the opt-in
 * context-window indicator.
 */
function ComposerSection() {
  const { t } = useTranslation("settings");
  const sendWithModifier = cmdEnterToSend.useValue();
  const showContextWindow = showContextWindowIndicator.useValue();

  // On touch devices the composer never submits on Enter (it always inserts
  // a newline; sending happens via the send button), so that toggle would be
  // a no-op control. The context-window toggle applies on every surface.
  const showSendToggle = !isPointerCoarse();
  const isMac = isMacOSBrowser();

  return (
    <section>
      <h3 className="text-title-small text-[var(--content-emphasised)]">
        {t("preferencesModal.composerTitle")}
      </h3>
      <div className="mt-2 space-y-4">
        {showSendToggle && (
          <Toggle
            checked={sendWithModifier}
            onChange={cmdEnterToSend.save}
            label={
              isMac
                ? t("preferencesModal.sendWithCmdEnter")
                : t("preferencesModal.sendWithCtrlEnter")
            }
            helperText={
              isMac
                ? t("preferencesModal.sendWithCmdEnterHelper")
                : t("preferencesModal.sendWithCtrlEnterHelper")
            }
          />
        )}
        <Toggle
          checked={showContextWindow}
          onChange={showContextWindowIndicator.save}
          label={t("preferencesModal.showContextWindow")}
          helperText={t("preferencesModal.showContextWindowHelper")}
        />
      </div>
    </section>
  );
}

/** Electron-only toggle for launching the app when the user logs in. */
function LaunchAtLoginSection() {
  const { t } = useTranslation("settings");
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
        {t("preferencesModal.launchAtLoginTitle")}
      </h3>
      <p className="text-body-medium-default text-[var(--content-tertiary)]">
        {t("preferencesModal.launchAtLoginDescription")}
      </p>
      <div className="mt-2">
        <Toggle
          checked={enabled}
          onChange={(next) => void handleToggle(next)}
          aria-label={t("preferencesModal.launchAtLoginAriaLabel")}
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
 * Hosts the shortcut rebinding sections (Electron only — hotkeys drive Electron
 * globalShortcut + menu accelerators with no web/iOS analogue), the composer
 * section, and the Launch at Login toggle. The theme picker is a separate
 * Appearance card on Settings → General.
 */
export function PreferencesModal({ open, onClose }: PreferencesModalProps) {
  const { t } = useTranslation("settings");

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
          <Modal.Title>{t("preferencesModal.title")}</Modal.Title>
          <Modal.Description>
            {t("preferencesModal.description")}
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <div className="space-y-6">
            {isElectron() && (
              <section>
                <h3 className="text-title-small text-[var(--content-emphasised)]">
                  {t("preferencesModal.keyboardShortcutsTitle")}
                </h3>
                <p className="text-body-medium-default text-[var(--content-tertiary)]">
                  {t("preferencesModal.keyboardShortcutsDescription")}
                </p>
                <div className="mt-2">
                  <ShortcutsSections />
                </div>
              </section>
            )}
            <ComposerSection />
            {isElectron() && <LaunchAtLoginSection />}
          </div>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
