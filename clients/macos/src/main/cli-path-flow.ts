/**
 * UX orchestration for "Install vellum Command…": wraps the cli-path-installer
 * primitives with confirmation/success dialogs and clipboard help. Both flows
 * surface failures via showErrorBox and never throw to the caller.
 */
import { clipboard, dialog } from "electron";

import { ensureCliInstalled } from "./cli-installer";
import {
  getCliPathInstallState,
  getWrapperPath,
  installWrapper,
  uninstallWrapper,
} from "./cli-path-installer";
import { isFishShell } from "./shell-path";

const PATH_EXPORT_LINE = 'export PATH="$HOME/.local/bin:$PATH"';
const FISH_ADD_PATH_LINE = 'fish_add_path "$HOME/.local/bin"';

// Shared by both flows: they mutate the same wrapper file, and re-entrant
// runs stack dialogs and overwrite each other's answers.
let flowInFlight = false;

/** Whether an install/uninstall flow is currently running. */
export function isCliPathFlowInFlight(): boolean {
  return flowInFlight;
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : "Unknown error";

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

// Copies the shell-appropriate PATH fix and returns matching instructions:
// fish persists PATH via fish_add_path, not a POSIX export in a profile.
function copyPathExportHelp(): string {
  if (isFishShell()) {
    clipboard.writeText(FISH_ADD_PATH_LINE);
    return (
      "~/.local/bin isn't in your shell's PATH. The fish command to add " +
      "it has been copied to your clipboard — run it once in a fish " +
      "terminal."
    );
  }
  clipboard.writeText(PATH_EXPORT_LINE);
  return (
    "~/.local/bin isn't in your shell's PATH. The line to add to your " +
    "shell profile has been copied to your clipboard."
  );
}

async function showInstallSuccessDialog(): Promise<void> {
  const state = await getCliPathInstallState();
  const wrapperPath = getWrapperPath();

  let detail: string;
  if (state.kind === "installed" && !state.inPath) {
    detail =
      `The vellum command is installed at ${wrapperPath}, but ` +
      copyPathExportHelp();
  } else if (state.kind === "shadowed") {
    detail =
      `The vellum command is installed at ${wrapperPath}, but another ` +
      `"vellum" was found at ${state.shadowedBy} (likely installed via ` +
      "npm) and will take precedence in your terminal. Run " +
      '"npm uninstall -g vellum" to use the app-managed version.';
    if (!state.inPath) {
      detail += ` Also, ${copyPathExportHelp()}`;
    }
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
  if (flowInFlight) return;
  flowInFlight = true;
  try {
    if (installWrapper({ overwriteForeign: false }) === "needs-overwrite-confirmation") {
      if (!(await confirmReplaceForeignFile())) return;
      installWrapper({ overwriteForeign: true });
    }

    try {
      await ensureCliInstalled();
    } catch (err) {
      throw new Error(
        `The vellum command was installed at ${getWrapperPath()}, but ` +
          `downloading the CLI runtime failed: ${errorMessage(err)}. Use ` +
          '"Repair vellum Command" in the Vellum menu to retry now — or it ' +
          "will be retried automatically the next time it's needed.",
      );
    }

    await showInstallSuccessDialog();
  } catch (err) {
    dialog.showErrorBox("Failed to install vellum command", errorMessage(err));
  } finally {
    flowInFlight = false;
  }
}

export async function runUninstallCliCommandFlow(): Promise<void> {
  if (flowInFlight) return;
  flowInFlight = true;
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
    dialog.showErrorBox("Failed to uninstall vellum command", errorMessage(err));
  } finally {
    flowInFlight = false;
  }
}
