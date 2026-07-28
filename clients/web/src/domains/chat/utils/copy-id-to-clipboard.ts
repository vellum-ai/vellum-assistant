import { toast } from "@vellumai/design-library/components/toast";

/**
 * Copy an identifier (conversation id, group id) to the clipboard with toast
 * feedback. Shared by the conversation and group overflow menus so users can
 * paste a precise reference into chat for the assistant to act on.
 */
export function copyIdToClipboard(id: string, label: string): void {
  navigator.clipboard.writeText(id).then(
    () => toast.success(`${label} copied to clipboard.`),
    () => toast.error(`Couldn't copy the ${label.toLowerCase()}.`),
  );
}
