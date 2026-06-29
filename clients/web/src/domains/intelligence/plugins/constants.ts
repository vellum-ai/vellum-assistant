/**
 * Shared user-facing copy for the plugin surfaces (desktop detail, mobile
 * detail, and the Plugins tab), kept in one place so the confirm dialogs and
 * failure messages stay in lockstep across them.
 */

/** Confirm-dialog body for removing an installed plugin. */
export const pluginRemoveConfirmMessage = (name: string): string =>
  `Remove "${name}" from this assistant?`;

/** Confirm-dialog body for an upgrade that would clobber local edits. */
export const pluginRiskyUpgradeConfirmMessage = (name: string): string =>
  `"${name}" has local edits that will be overwritten by the upgrade. Continue?`;

/** Failure copy for a failed install / remove / upgrade attempt. */
export const PLUGIN_INSTALL_ERROR =
  "Failed to install plugin. Please try again.";
export const PLUGIN_REMOVE_ERROR = "Failed to remove plugin. Please try again.";
export const PLUGIN_UPGRADE_ERROR =
  "Failed to upgrade plugin. Please try again.";
