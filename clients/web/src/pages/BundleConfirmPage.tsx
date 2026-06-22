import { useEffect, useState } from "react";

import { formatFileSize } from "@/domains/workspace/utils/format-file-size";
import type { BundleScanData } from "@/runtime/is-electron";
import { cn } from "@/utils/misc";

const TRUST_BADGE: Record<
  BundleScanData["signatureResult"]["trustTier"],
  { label: string; className: string }
> = {
  verified: {
    label: "Verified",
    className: "bg-[var(--system-positive-weak)] text-[var(--system-positive-strong)]",
  },
  signed: {
    label: "Signed",
    className: "bg-[var(--system-info-weak)] text-[var(--system-info-strong)]",
  },
  unsigned: {
    label: "Unsigned",
    className: "bg-[var(--surface-active)] text-[var(--content-secondary)]",
  },
  tampered: {
    label: "Tampered — signature invalid",
    className: "bg-[var(--system-negative-weak)] text-[var(--system-negative-strong)]",
  },
};

export function BundleConfirmPage() {
  const [data, setData] = useState<BundleScanData | null>(null);
  const [warningsOpen, setWarningsOpen] = useState(false);

  useEffect(() => {
    void window.vellum?.bundleConfirm?.getData().then((d) => {
      if (d) setData(d);
    });
  }, []);

  if (!data) {
    return (
      <div className="flex h-svh w-screen items-center justify-center bg-background text-muted-foreground select-none">
        Loading...
      </div>
    );
  }

  const { manifest, scanResult, signatureResult, bundleSizeBytes } = data;
  const badge = TRUST_BADGE[signatureResult.trustTier];
  const isTampered = signatureResult.trustTier === "tampered";
  const warnings = scanResult.warnings;

  return (
    <div className="flex h-svh w-screen flex-col bg-background px-6 pt-14 pb-6 text-foreground select-none">
      {/* Header */}
      <div className="flex items-start gap-3">
        {manifest.icon ? (
          <span className="text-5xl leading-none">{manifest.icon}</span>
        ) : (
          <span className="text-5xl leading-none">📦</span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{manifest.name}</h1>
          {manifest.description && (
            <p className="text-muted-foreground mt-0.5 text-sm leading-snug">
              {manifest.description}
            </p>
          )}
        </div>
      </div>

      {/* Trust badge */}
      <div className="mt-4 flex items-center gap-2">
        <span
          className={cn(
            "inline-block rounded-full px-2.5 py-0.5 text-xs font-medium",
            badge.className,
          )}
        >
          {badge.label}
        </span>
        {signatureResult.trustTier === "signed" &&
          signatureResult.signerDisplayName && (
            <span className="text-muted-foreground text-xs">
              by {signatureResult.signerDisplayName}
            </span>
          )}
      </div>

      {/* Details */}
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Size</dt>
        <dd>{formatFileSize(bundleSizeBytes)}</dd>
        <dt className="text-muted-foreground">Created by</dt>
        <dd className="truncate">{manifest.created_by}</dd>
        {manifest.capabilities.length > 0 && (
          <>
            <dt className="text-muted-foreground">Capabilities</dt>
            <dd className="truncate">{manifest.capabilities.join(", ")}</dd>
          </>
        )}
      </dl>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            className="text-muted-foreground text-xs font-medium hover:underline"
            onClick={() => setWarningsOpen((v) => !v)}
          >
            {warningsOpen ? "Hide" : "Show"} Warnings ({warnings.length})
          </button>
          {warningsOpen && (
            <ul className="mt-1.5 space-y-1 text-xs">
              {warnings.map((msg, i) => (
                <li
                  key={i}
                  className="rounded bg-[var(--system-mid-weak)] px-2 py-1 text-[var(--system-mid-strong)]"
                >
                  {msg}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="mt-auto flex items-center justify-end gap-3 pt-4">
        <button
          type="button"
          className="rounded-md border border-border px-4 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
          onClick={() => window.vellum?.bundleConfirm?.respond(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className={cn(
            "rounded-md px-4 py-1.5 text-sm font-medium text-white",
            isTampered
              ? "bg-red-600 hover:bg-red-700"
              : "bg-primary hover:bg-primary/90",
          )}
          onClick={() => window.vellum?.bundleConfirm?.respond(true)}
        >
          {isTampered ? "Install Anyway" : "Install"}
        </button>
      </div>
    </div>
  );
}
