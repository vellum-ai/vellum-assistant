"use client";

import { Link as LinkIcon } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";

interface SectionHeadingProps {
  id: string;
  level: 2 | 3;
  children: ReactNode;
  className?: string;
}

export function SectionHeading({ id, level, children, className }: SectionHeadingProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyLink = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      const url = `${window.location.origin}${window.location.pathname}#${id}`;
      // Update the URL hash so the browser reflects the anchor.
      window.history.replaceState(null, "", `#${id}`);
      void navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 2000);
      });
    },
    [id],
  );

  const baseH2 =
    "not-prose mb-4 mt-10 text-left font-['DM_Sans',sans-serif] text-3xl font-bold tracking-tight text-zinc-900";
  const baseH3 =
    "not-prose mb-3 mt-8 text-left font-['DM_Sans',sans-serif] text-xl font-bold tracking-tight text-zinc-800";

  const headingClass = `group relative ${level === 2 ? baseH2 : baseH3} ${className ?? ""}`.trim();

  const linkButton = (
    <a
      href={`#${id}`}
      onClick={handleCopyLink}
      className="relative ml-2 inline-flex items-center align-middle opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
      aria-label={`Copy link to ${typeof children === "string" ? children : "section"}`}
    >
      <LinkIcon
        size={level === 2 ? 18 : 16}
        className={
          copied
            ? "text-emerald-600"
            : "text-zinc-400 hover:text-emerald-600"
        }
      />
      {copied ? (
        <span className="pointer-events-none absolute left-full ml-2 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white shadow-sm">
          Link copied
        </span>
      ) : null}
    </a>
  );

  if (level === 2) {
    return (
      <h2 id={id} className={headingClass}>
        {children}
        {linkButton}
      </h2>
    );
  }

  return (
    <h3 id={id} className={headingClass}>
      {children}
      {linkButton}
    </h3>
  );
}
