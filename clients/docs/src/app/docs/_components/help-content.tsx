"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";

const HELP_PAGES = [
  { title: "FAQ", href: "/docs/help/faq", description: "The questions everyone asks. Answered once, linked everywhere." },
  { title: "Common Issues", href: "/docs/help/common-issues", description: "Things that go wrong and how to fix them." },
  { title: "Getting Help", href: "/docs/help/getting-help", description: "Where to go when the docs aren't enough." },
];

export function HelpContent() {
  return (
    <DocsContent title="Help" breadcrumb="Docs / Help">
      <p className="mb-6 text-zinc-600">
        Something&apos;s not working, something&apos;s confusing, or you just have a question.
        We&apos;ve got you.
      </p>

      <div className="docs-nav-cards">
        {HELP_PAGES.map((page) => (
          <a key={page.href} href={page.href} className="docs-nav-card">
            <div className="docs-nav-card-content">
              <span className="docs-nav-card-title">{page.title}</span>
              <span className="docs-nav-card-desc">{page.description}</span>
            </div>
            <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
          </a>
        ))}
      </div>
    </DocsContent>
  );
}
