import { copyToClipboard } from "@/lib/copy-to-clipboard";

/**
 * Copy an identifier (conversation id, group id) to the clipboard with toast
 * feedback. Shared by the conversation and group overflow menus so users can
 * paste a precise reference into chat for the assistant to act on.
 */
export function copyIdToClipboard(id: string, label: string): void {
  copyToClipboard(id, {
    successMessage: `${label} copied to clipboard.`,
    errorMessage: `Couldn't copy the ${label.toLowerCase()}.`,
  });
}
