/**
 * Shared user-facing copy for the plugin surfaces (desktop detail, mobile
 * detail, and the Plugins tab), kept in one place so the confirm dialogs and
 * failure messages stay in lockstep across them.
 */

import { t } from "@/i18n";

/** Confirm-dialog body for removing an installed plugin. */
export const pluginRemoveConfirmMessage = (name: string): string =>
  t("pluginConstants.removeConfirmMessage", { ns: "intelligence", name });

/** Confirm-dialog body for an upgrade that would clobber local edits. */
export const pluginRiskyUpgradeConfirmMessage = (name: string): string =>
  t("pluginConstants.riskyUpgradeConfirmMessage", {
    ns: "intelligence",
    name,
  });

/** Confirm-dialog button label for the risky (local-edit-overwriting) upgrade. */
export const pluginRiskyUpgradeConfirmLabel = t(
  "pluginConstants.riskyUpgradeConfirmLabel",
  { ns: "intelligence" },
);

/** Failure copy for a failed install / remove / upgrade attempt. */
export const PLUGIN_INSTALL_ERROR = t("pluginConstants.installError", {
  ns: "intelligence",
});
export const PLUGIN_REMOVE_ERROR = t("pluginConstants.removeError", {
  ns: "intelligence",
});
export const PLUGIN_UPGRADE_ERROR = t("pluginConstants.upgradeError", {
  ns: "intelligence",
});
export const PLUGIN_TOGGLE_ERROR = t("pluginConstants.toggleError", {
  ns: "intelligence",
});
