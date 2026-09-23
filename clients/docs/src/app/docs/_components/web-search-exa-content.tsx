import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-it-does", label: "What it does", level: 2 as const },
  { id: "prerequisites", label: "Prerequisites", level: 2 as const },
  { id: "setup", label: "Setup", level: 2 as const },
  { id: "best-practices", label: "Best practices", level: 2 as const },
  { id: "resources", label: "Resources", level: 2 as const },
];

export function WebSearchExaContent() {
  return (
    <>
      <DocsContent
        title="Exa"
        breadcrumb="Docs / Key Concepts / Web Search / Exa"
        subtitle="Neural web search built for AI agents. Use Exa in your Vellum assistant for meaning-based retrieval that returns the most relevant passages from each page alongside the link."
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Exa is a search engine designed for LLMs rather than people typing
            keywords. It embeds your query and matches it against the meaning of
            pages, so descriptive, natural-language questions work as well as
            short keyword queries. Each result carries the page title, URL,
            publish date when known, and highlights: the passages from the page
            that best answer the query.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            When configured, Vellum sends web search calls to Exa, asks for
            highlights on every result, and feeds them back to your assistant in
            context. The model can cite the passages directly, open a source
            with web fetch, or synthesize an answer across several results.
          </p>
        </section>

        <section id="prerequisites" className="mt-12">
          <SectionHeading id="prerequisites" level={2}>
            Prerequisites
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              A running Vellum assistant. Cloud, self-hosted, or the desktop
              apps all work.
            </li>
            <li>
              An Exa API key. Create one at{" "}
              <Link
                href="https://dashboard.exa.ai/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                dashboard.exa.ai
              </Link>
              . Exa keys are opaque strings with no fixed prefix.
            </li>
          </ul>
        </section>

        <section id="setup" className="mt-12">
          <SectionHeading id="setup" level={2}>
            Setup
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Exa is BYOK (bring your own key). You stay in control of the key and
            pay Exa directly for usage.
          </p>
          <ol className="mb-6 list-decimal space-y-3 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong>Open assistant settings.</strong> In Vellum, head to{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Settings &rarr; Models &amp; Services
              </span>
              .
            </li>
            <li>
              <strong>Add your Exa API key.</strong> Under the{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Web Search
              </span>{" "}
              section, choose{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Exa
              </span>{" "}
              as the provider and paste your API key. Vellum stores the key in
              your local secure store and never writes it to disk in plaintext.
            </li>
            <li>
              <strong>Try it.</strong> Start a new conversation and ask a
              question that needs fresh or hard-to-find information. Vellum
              calls Exa under the hood and feeds the highlighted passages back
              to the model in context.
            </li>
          </ol>
          <p className="mb-3 text-zinc-600 dark:text-zinc-400">
            Prefer the CLI? From any shell where the assistant daemon is
            running:
          </p>
          <div className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4">
            <pre className="font-[family-name:var(--font-dm-mono)] text-sm text-zinc-100">
              {`assistant keys set exa <your-exa-api-key>
assistant config set services.web-search.provider exa`}
            </pre>
          </div>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Swap or revoke the key at any time with{" "}
            <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200">
              assistant keys delete exa
            </code>
            .
          </p>
        </section>

        <section id="best-practices" className="mt-12">
          <SectionHeading id="best-practices" level={2}>
            Best practices
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong>Describe what you want, not just keywords.</strong> Exa
              matches on meaning, so &quot;a blog post explaining how vector
              databases handle deletes&quot; retrieves better than &quot;vector
              db delete&quot;. Your assistant already phrases queries this way;
              you rarely need to coach it.
            </li>
            <li>
              <strong>Recency filters are hard cutoffs.</strong> When the
              assistant asks for results from the past day, week, month, or
              year, Vellum passes that window to Exa as a publish-date filter.
              Pages without a detectable publish date are dropped from filtered
              searches, so leave the filter off for evergreen topics.
            </li>
            <li>
              <strong>Fallback behavior.</strong> Exa participates in the web
              search fallback chain after the other BYOK providers. The chain
              skips any provider without a key connected; if none are connected,
              the search returns an error. See the{" "}
              <Link
                href="/docs/key-concepts/web-search"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Web Search
              </Link>{" "}
              page for the full fallback rules.
            </li>
            <li>
              <strong>Billing.</strong> Exa usage is billed per request directly
              by Exa under the account that owns the key, separately from Vellum
              credits.
            </li>
            <li>
              <strong>Privacy.</strong> Search queries leave your assistant and
              reach Exa servers. Review the{" "}
              <Link
                href="https://exa.ai/privacy-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Exa privacy policy
              </Link>{" "}
              for details.
            </li>
          </ul>
        </section>

        <section id="resources" className="mt-12">
          <SectionHeading id="resources" level={2}>
            Resources
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <Link
                href="https://docs.exa.ai/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Exa documentation
              </Link>
            </li>
            <li>
              <Link
                href="https://dashboard.exa.ai/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Exa API key dashboard
              </Link>
            </li>
            <li>
              <Link
                href="/docs/key-concepts/web-search"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Vellum Web Search reference
              </Link>
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
