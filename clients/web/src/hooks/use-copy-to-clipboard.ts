import { useCallback, useEffect, useRef, useState } from "react";

const COPIED_RESET_MS = 1500;

/**
 * Copies text to the clipboard and tracks a transient "copied" flag that
 * auto-resets after a short delay. Handles cleanup on unmount.
 */
export function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, []);

  return { copy, copied } as const;
}
