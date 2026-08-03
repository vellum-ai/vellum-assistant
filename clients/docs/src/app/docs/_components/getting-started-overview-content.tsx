"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";

const GETTING_STARTED_PAGES = [
  {
    title: "What is Vellum?",
    href: "/docs/getting-started/what-is-vellum",
    description:
      "The big picture. What it is, what it isn't, why it exists.",
  },
  {
    title: "Installation",
    href: "/docs/getting-started/installation",
    description:
      "Sign up for Vellum Cloud, install the desktop app, or self-host. (All easy, we promise.)",
  },
  {
    title: "Quick Start",
    href: "/docs/getting-started/quick-start",
    description:
      "Your first 5 minutes. From zero to \"this is actually useful.\"",
  },
  {
    title: "Self-improving Skills",
    href: "/docs/key-concepts/self-improving-skills",
    description:
      "How your assistant turns completed work into reusable skills and improves them over time.",
  },
];

export function GettingStartedOverviewContent() {
  return (
    <DocsContent title="Getting Started" breadcrumb="Docs / Getting Started">
      <p className="mb-4 text-zinc-600">
        You&apos;re here because you want a personal AI assistant that actually does things.
        Good news: you&apos;re about 5 minutes away from having one.
      </p>

      <p className="mb-6 text-zinc-600">
        This section covers everything you need to go from &ldquo;what is this?&rdquo; to
        &ldquo;oh wow, it just ordered me lunch.&rdquo;
      </p>

      <div className="docs-nav-cards">
        {GETTING_STARTED_PAGES.map((page) => (
          <a key={page.href} href={page.href} className="docs-nav-card">
            <div className="docs-nav-card-content">
              <span className="docs-nav-card-title">{page.title}</span>
              <span className="docs-nav-card-desc">{page.description}</span>
            </div>
            <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
          </a>
        ))}
      </div>

      <p className="mt-6 mb-0 text-zinc-600">
        No prior AI experience needed. No terminal wizardry required. Just sign up, open
        your assistant in the browser, and start talking.
      </p>
    </DocsContent>
  );
}
