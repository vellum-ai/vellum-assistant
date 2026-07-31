import { type ReactNode } from "react";

import { CopyPageButton } from "@/app/docs/_components/copy-page-button";

interface DocsContentProps {
  title: string;
  breadcrumb: string;
  /** Small accent-colored label rendered above the title. Replaces the
   *  breadcrumb when present. */
  eyebrow?: string;
  /** Light-gray description rendered below the title. */
  subtitle?: string;
  /** Path used by the Copy page button. Defaults to the current pathname
   *  resolved client-side. Set to `null` to hide the button. */
  copyPagePath?: string | null;
  children: ReactNode;
}

/**
 * Auto-derive an eyebrow from a breadcrumb when the page doesn't pass one
 * explicitly. For "Docs / Getting Started / What is Vellum?" this returns
 * "Getting Started". For shallow paths like "Docs / Pricing" it returns null
 * and the breadcrumb is rendered instead.
 */
function deriveEyebrow(breadcrumb: string): string | null {
  const parts = breadcrumb
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (parts.length < 3) {return null;}
  return parts[parts.length - 2] ?? null;
}

export function DocsContent({
  title,
  breadcrumb,
  eyebrow,
  subtitle,
  copyPagePath,
  children,
}: DocsContentProps) {
  const showCopyButton = copyPagePath !== null;
  const resolvedEyebrow = eyebrow ?? deriveEyebrow(breadcrumb);

  return (
    <div className="docs-main min-w-0 flex-1">
      {resolvedEyebrow ? (
        <div className="docs-eyebrow mb-2 text-sm font-medium">{resolvedEyebrow}</div>
      ) : (
        <div className="docs-breadcrumb mb-2 text-sm">{breadcrumb}</div>
      )}
      <div className="docs-title-row mt-2 mb-4 flex items-start justify-between gap-6">
        <h1 className="docs-title font-['DM_Sans',sans-serif] text-4xl font-bold tracking-tight md:text-5xl">
          {title}
        </h1>
        {showCopyButton ? (
          <CopyPageButton path={copyPagePath ?? undefined} />
        ) : null}
      </div>
      {subtitle ? (
        <p className="docs-subtitle mb-8 text-lg leading-relaxed">{subtitle}</p>
      ) : (
        <div className="mb-8" />
      )}
      <div className="docs-prose prose prose-zinc max-w-none">{children}</div>
    </div>
  );
}
