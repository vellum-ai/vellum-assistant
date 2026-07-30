"use client";

import { routes } from "@/lib/routes";

import { DocsContent } from "@/app/docs/_components/docs-content";

const TRUST_PAGES = [
  {
    title: "Privacy & Data",
    href: routes.docs.legal.privacyAndData,
    description:
      "What lives in your assistant's workspace, what leaves, and where it goes.",
  },
  {
    title: "The Permissions Model",
    href: "/docs/trust-security/the-permissions-model",
    description:
      "How Allow / Deny works, risk tolerance tiers, and trust rules.",
  },
  {
    title: "Security Best Practices",
    href: "/docs/trust-security/security-best-practices",
    description:
      "Practical tips for staying safe while using a powerful tool.",
  },
];

export function TrustSecurityContent() {
  return (
    <DocsContent title="Trust & Security" breadcrumb="Docs / Trust & Security">
      <p className="mb-4 text-zinc-600">
        This is the section most AI products bury in a footer link next to
        &quot;Terms of Service&quot; and &quot;Cookie Policy.&quot; We&apos;re putting it front and
        center because we think you deserve to know exactly how this works before
        you hand an AI access to your computer.
      </p>
      <p className="mb-6 text-zinc-600">
        We&apos;re going to be transparent to the point of being annoying about it.
        That&apos;s intentional.
      </p>

      <div className="docs-nav-cards">
        {TRUST_PAGES.map((page) => (
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
