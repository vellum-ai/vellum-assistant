import { t } from "@/i18n";
import { copyToClipboard } from "@/lib/copy-to-clipboard";

/** The identifiers an overflow menu can put on the clipboard. */
export type CopyableIdKind = "conversation" | "group";

/**
 * Copy an identifier (conversation id, group id) to the clipboard with toast
 * feedback. Shared by the conversation and group overflow menus so users can
 * paste a precise reference into chat for the assistant to act on.
 *
 * Takes the kind rather than a display label so every message is a whole
 * sentence in the catalog. A translator can move "conversation ID" anywhere in
 * the sentence, which a label interpolated into an English frame cannot
 * express. The bound `t` is right here because the result goes to a toast
 * fired at click time, not to rendered output that has to survive a language
 * switch.
 *
 * Owns the wording only. `copyToClipboard` owns the write, and is the one
 * place that guards a missing Clipboard API and reports failures through
 * `captureError`. That reporting matters because the shell can refuse a write
 * the page considers fine, as an Electron permission did in LUM-2321.
 */
export function copyIdToClipboard(id: string, kind: CopyableIdKind): void {
  copyToClipboard(
    id,
    kind === "conversation"
      ? {
          successMessage: t("chat:copyIdToClipboard.conversationCopied"),
          errorMessage: t("chat:copyIdToClipboard.conversationFailed"),
        }
      : {
          successMessage: t("chat:copyIdToClipboard.groupCopied"),
          errorMessage: t("chat:copyIdToClipboard.groupFailed"),
        },
  );
}
