import { useCallback, useEffect, useRef, useState } from "react";

import { copyToClipboard } from "@/lib/copy-to-clipboard";

const COPIED_RESET_MS = 1500;

export interface UseCopyToClipboardOptions {
  /** Toast shown when the clipboard write fails. */
  errorMessage: string;
}

/**
 * Copies text to the clipboard and tracks a transient "copied" flag that
 * auto-resets after a short delay. Handles cleanup on unmount.
 *
 * The write goes through `copyToClipboard`, so a failed write toasts and is
 * reported rather than passing silently, and the flag flips only once the
 * write resolves. A "Copied!" affordance that appears whether or not the
 * clipboard took the text is worse than none: it tells the user to go paste
 * something that isn't there.
 *
 * `copy` takes an optional `onCopied` for work that must not happen on a
 * failed write, such as advancing a flow that depends on the clipboard.
 */
export function useCopyToClipboard({
  errorMessage,
}: UseCopyToClipboardOptions) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const copy = useCallback(
    (text: string, onCopied?: () => void) => {
      copyToClipboard(text, {
        errorMessage,
        onCopied: () => {
          setCopied(true);
          if (timerRef.current) {
            clearTimeout(timerRef.current);
          }
          timerRef.current = setTimeout(
            () => setCopied(false),
            COPIED_RESET_MS,
          );
          onCopied?.();
        },
      });
    },
    [errorMessage],
  );

  return { copy, copied } as const;
}
