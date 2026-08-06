"use client";

import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";

interface CopyPageButtonProps {
  /** Path appended to window.location.origin. Defaults to the current
   *  pathname when the button is clicked. */
  path?: string;
}

export function CopyPageButton({ path }: CopyPageButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(() => {
    const target =
      typeof window === "undefined"
        ? path ?? ""
        : `${window.location.origin}${path ?? window.location.pathname}`;
    if (!target) {
      return;
    }
    void navigator.clipboard
      .writeText(target)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 2000);
      })
      .catch(() => {
        // Clipboard write can fail in restricted contexts. Silent fallback —
        // the user can still copy the URL from the address bar.
      });
  }, [path]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="docs-copy-page shrink-0 inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors"
      aria-label={copied ? "Page link copied" : "Copy page link"}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span>{copied ? "Copied" : "Copy page"}</span>
    </button>
  );
}
