import { toast } from "@vellumai/design-library/components/toast";

import { captureError } from "@/lib/sentry/capture-error";

interface CopyToClipboardOptions {
  /**
   * Toast shown after a successful write. Omit when the call site renders its
   * own success feedback (e.g. a transient copied icon) via `onCopied`.
   */
  successMessage?: string;
  /** Toast shown when the clipboard write fails. */
  errorMessage: string;
  /**
   * Runs after a successful write, for call-site feedback the toast can't
   * express (flipping a transient "copied" flag on the triggering control).
   */
  onCopied?: () => void;
}

/**
 * Copy text to the clipboard with user-facing feedback on both outcomes.
 *
 * Clipboard writes can fail (permissions, unfocused document, webview
 * restrictions), so `errorMessage` is required: every caller surfaces an
 * error toast instead of failing silently. Failures are also reported via
 * `captureError`. The Clipboard API itself may be absent (insecure
 * contexts, older webviews); that takes the same error path.
 *
 * Call sites that render a transient copied icon keep that state themselves
 * and flip it in `onCopied`. `useCopyToClipboard` from
 * `@/hooks/use-copy-to-clipboard` serves the sibling pattern where the hook
 * owns the copied flag and its auto-reset timer.
 */
export function copyToClipboard(
  text: string,
  options: CopyToClipboardOptions,
): void {
  if (!navigator.clipboard?.writeText) {
    captureError(new Error("Clipboard API unavailable"), {
      context: "copyToClipboard",
    });
    toast.error(options.errorMessage);
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => {
      options.onCopied?.();
      if (options.successMessage) {
        toast.success(options.successMessage);
      }
    },
    (err: unknown) => {
      captureError(err, { context: "copyToClipboard" });
      toast.error(options.errorMessage);
    },
  );
}
