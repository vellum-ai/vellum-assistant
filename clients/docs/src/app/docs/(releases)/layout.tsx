import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { type ReactNode } from "react";

import { ReleasesNav } from "@/app/docs/_components/releases-nav";
import { DocsNavProvider } from "@/app/docs/_components/docs-nav-context";
import { DocsGithubLink } from "@/app/docs/_components/docs-github-link";
import { DocsNavCta } from "@/app/docs/_components/docs-nav-cta";
import { DocsSearch } from "@/app/docs/_components/docs-search";
import { DocsThemePicker } from "@/app/docs/_components/docs-theme-picker";
import { DocsMobileMenuButton } from "@/app/docs/_components/docs-mobile-menu-button";
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
    <DocsNavProvider>
      <div className="docs-shell min-h-screen">
        <header className="docs-header sticky top-0 z-20 border-b backdrop-blur">
          {/* Top row in centered band */}
          <div className="mx-auto max-w-[1280px]">
            <div className="flex h-14 items-center">
              <div className="docs-brand-area flex h-full items-center gap-2 px-4 md:w-64 md:shrink-0 md:px-6">
                {/* Mobile: hamburger menu button */}
                <DocsMobileMenuButton />
                {/* Desktop: logo */}
                <a
                  href={`https://${WWW_DOMAIN}`}
                  className="hidden md:flex items-center gap-2 no-underline"
                >
                  <Image
                    src="/docs/vellum-logo.svg"
                    alt="Vellum"
                    width={100}
                    height={24}
                    unoptimized
                  />
                </a>
              </div>
              <div className="flex h-full flex-1 items-center gap-6 px-4 md:pl-8 md:pr-4">
                <div className="docs-header-search hidden md:block md:max-w-md md:flex-1">
                  <DocsSearch />
                </div>
                <div className="flex items-center gap-3 md:ml-auto">
                  <div className="hidden md:block">
                    <DocsThemePicker />
                  </div>
                  <DocsNavCta />
                  <div className="hidden md:block">
                    <DocsGithubLink />
                  </div>
                </div>
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
                  <a
                    href={`https://${WWW_DOMAIN}/plugins`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="docs-header-link text-sm font-medium no-underline"
                  >
                    Plugins
                  </a>
                  <a
                    href={`https://${WWW_DOMAIN}/community`}
                    className="docs-header-link text-sm font-medium no-underline"
                  >
                    Community
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
    </DocsNavProvider>
  );
}
