import { Check, Copy } from "lucide-react";
import { useState } from "react";

import type { Surface } from "@/domains/chat/types/types";

interface CopyBlockSurfaceData {
  text?: string;
  label?: string;
  language?: string;
}

interface CopyBlockSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
}

export function CopyBlockSurface({ surface }: CopyBlockSurfaceProps) {
  const data = surface.data as CopyBlockSurfaceData;
  const [copied, setCopied] = useState(false);
  const text = data.text ?? "";
  const label = data.label ?? data.language;

  const handleCopy = async () => {
    if (!text) return;
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)] p-3">
      {label && (
        <div className="mb-2 truncate text-label-small-default text-[var(--content-tertiary)]">
          {label}
        </div>
      )}
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-body-medium-default font-medium leading-snug text-[var(--content-strong)]">
        {text}
      </pre>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={handleCopy}
          disabled={!text}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] px-2.5 text-label-medium-default text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-strong)] disabled:opacity-50"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
