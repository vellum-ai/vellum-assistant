import type { Metadata } from "next";
import Link from "next/link";
import { type ReactNode } from "react";

import { ReleasesNav } from "@/app/docs/_components/releases-nav";
import { WWW_DOMAIN } from "@/lib/domains";
import { fetchReleases } from "@/lib/releases-server";

import "@/app/docs/docs-theme.css";

export const metadata: Metadata = {
  description:
    "Release notes for Vellum. See what's new, what changed, and what's coming.",
};

interface ReleasesLayoutProps {
  children: ReactNode;
}

export default async function ReleasesLayout({
  children,
}: ReleasesLayoutProps) {
  const releases = await fetchReleases();

  return (
    <div className="docs-shell min-h-screen">
      <header className="docs-header sticky top-0 z-20 border-b backdrop-blur">
        {/* Top row in centered band */}
        <div className="mx-auto max-w-[1280px]">
          <div className="flex h-14 items-center">
            <div className="docs-brand-area flex h-full items-center gap-2 px-4 md:w-64 md:shrink-0 md:px-6">
              <Link
                href="/docs"
                className="docs-nav-title flex items-center gap-2 font-['DM_Sans',sans-serif] text-lg font-bold no-underline"
              >
                Vellum
              </Link>
            </div>
          </div>
        </div>
        {/* Section nav band: border-t spans full viewport, content centered */}
        <div className="docs-header-tabs hidden border-t md:block">
          <div className="mx-auto max-w-[1280px]">
            <div className="flex h-11 items-center">
              <div className="md:w-64 md:shrink-0" />
              <div className="flex h-full flex-1 items-center gap-6 px-4 md:pl-8 md:pr-4">
                <Link
                  href="/docs"
                  className="docs-header-link text-sm font-medium no-underline"
                >
                  Docs
                </Link>
                <Link
                  href="/docs/releases"
                  className="docs-header-link docs-header-link-active text-sm font-medium no-underline"
                >
                  Releases
                </Link>
                <a
                  href={`https://${WWW_DOMAIN}/skills`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="docs-header-link text-sm font-medium no-underline"
                >
                  Skills
                </a>
              </div>
            </div>
          </div>
        </div>
      </header>
      <div className="docs-layout mx-auto flex max-w-[1280px] min-h-[calc(100vh-57px)] md:min-h-[calc(100vh-101px)]">
        <ReleasesNav releases={releases} />
        <div className="docs-content-area min-w-0 flex-1">
          <div className="flex items-start gap-6 px-4 py-6 md:px-10 md:py-10">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
