import { copyToClipboard } from "@/lib/copy-to-clipboard";

/**
 * Copy an identifier (conversation id, group id) to the clipboard with toast
 * feedback. Shared by the conversation and group overflow menus so users can
 * paste a precise reference into chat for the assistant to act on.
 *
 * Owns the wording only. `copyToClipboard` owns the write, and is the one
 * place that guards a missing Clipboard API and reports failures through
 * `captureError`. That reporting matters because the shell can refuse a write
 * the page considers fine, as an Electron permission did in LUM-2321.
 */
export function copyIdToClipboard(id: string, label: string): void {
  copyToClipboard(id, {
    successMessage: `${label} copied to clipboard.`,
    errorMessage: `Couldn't copy the ${label.toLowerCase()}.`,
  });
}
