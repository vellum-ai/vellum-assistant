/**
 * UX orchestration for "Install vellum Command…": wraps the cli-path-installer
 * primitives with confirmation/success dialogs and clipboard help. Both flows
 * surface failures via showErrorBox and never throw to the caller.
 */
import { clipboard, dialog } from "electron";

import {
  getCliPathInstallState,
  getWrapperPath,
  installWrapper,
  uninstallWrapper,
} from "./cli-path-installer";

const PATH_EXPORT_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

async function confirmReplaceForeignFile(): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: "Replace existing vellum file?",
    detail:
      `A "vellum" file already exists at ${getWrapperPath()} but wasn't ` +
      "installed by Vellum (it may have been installed by npm with a custom " +
      "prefix). Do you want to replace it with the Vellum-managed command?",
    buttons: ["Replace", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

async function showInstallSuccessDialog(): Promise<void> {
  const state = await getCliPathInstallState();
  const wrapperPath = getWrapperPath();

  let detail: string;
  if (state.kind === "installed" && !state.inPath) {
    clipboard.writeText(PATH_EXPORT_LINE);
    detail =
      `The vellum command is installed at ${wrapperPath}, but ` +
      "~/.local/bin isn't in your shell's PATH. The line to add to your " +
      "shell profile has been copied to your clipboard.";
  } else if (state.kind === "shadowed") {
    detail =
      `The vellum command is installed at ${wrapperPath}, but another ` +
      `"vellum" was found at ${state.shadowedBy} (likely installed via ` +
      "npm) and will take precedence in your terminal. Run " +
      '"npm uninstall -g vellum" to use the app-managed version.';
  } else {
    // `installed` in PATH, plus a defensive default for anything else.
    detail =
      `The vellum command is installed at ${wrapperPath}. ` +
      'Open a new terminal and run "vellum".';
  }

  await dialog.showMessageBox({
    type: "info",
    message: "Vellum CLI installed",
    detail,
  });
}

export async function runInstallCliCommandFlow(): Promise<void> {
  try {
    const state = await getCliPathInstallState();
    let overwriteForeign = false;
    if (state.kind === "foreign-file") {
      if (!(await confirmReplaceForeignFile())) return;
      overwriteForeign = true;
    }

    if (installWrapper({ overwriteForeign }) === "needs-overwrite-confirmation") {
      // Race: the file became foreign between the state check and install.
      if (!(await confirmReplaceForeignFile())) return;
      installWrapper({ overwriteForeign: true });
    }

    await showInstallSuccessDialog();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    dialog.showErrorBox("Failed to install vellum command", message);
  }
}

export async function runUninstallCliCommandFlow(): Promise<void> {
  try {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: "Uninstall vellum command?",
      detail: `This removes the vellum command at ${getWrapperPath()}.`,
      buttons: ["Uninstall", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;

    const resultDialogs = {
      removed: {
        type: "info",
        message: "Vellum command uninstalled",
        detail: "The vellum command was removed.",
      },
      "not-ours": {
        type: "warning",
        message: "Vellum command not removed",
        detail:
          `The file at ${getWrapperPath()} wasn't installed by Vellum — ` +
          "not removing it.",
      },
      absent: {
        type: "info",
        message: "Nothing to uninstall",
        detail: "The vellum command is not installed.",
      },
    } as const;
    await dialog.showMessageBox(resultDialogs[uninstallWrapper()]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    dialog.showErrorBox("Failed to uninstall vellum command", message);
  }
}
