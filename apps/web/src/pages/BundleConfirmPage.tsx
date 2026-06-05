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
    className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  },
  signed: {
    label: "Signed",
    className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  },
  unsigned: {
    label: "Unsigned",
    className: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  },
  tampered: {
    label: "Tampered — signature invalid",
    className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
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
  const warnings = scanResult.findings.filter((f) => f.level === "warn");

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
              {warnings.map((w, i) => (
                <li
                  key={`${w.code}-${i}`}
                  className="rounded bg-yellow-50 px-2 py-1 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200"
                >
                  <span className="font-medium">{w.code}</span>: {w.message}
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
