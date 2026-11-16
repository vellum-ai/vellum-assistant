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

export function WebSearchOutcrawlContent() {
  return (
    <>
      <DocsContent
        title="Outcrawl"
        breadcrumb="Docs / Key Concepts / Web Search / Outcrawl"
        subtitle="Web search built for AI agents. Use Outcrawl in your Vellum assistant when you want ranked results with a title, URL, and snippet for each, from the same API that can also scrape and crawl the pages it finds."
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Outcrawl is web infrastructure for AI agents: a real browser that
            searches, scrapes, crawls, and runs multi-step agent tasks. Its
            search API takes your query and returns the matching pages as
            structured JSON, in ranked order, with the page title, URL, and a
            snippet for each.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            When configured, Vellum sends web search calls to Outcrawl and feeds
            the results back to your assistant in context. The model can cite
            the snippets, open a source with web fetch, or synthesize an answer
            across several results.
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
              An Outcrawl API key. Create one at{" "}
              <Link
                href="https://outcrawl.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                outcrawl.ai
              </Link>
              . New accounts include a free tier of 1,000 credits a month and no
              card is required.
            </li>
          </ul>
        </section>

        <section id="setup" className="mt-12">
          <SectionHeading id="setup" level={2}>
            Setup
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Outcrawl is BYOK (bring your own key). You stay in control of the
            key and pay Outcrawl directly for usage.
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
              <strong>Add your Outcrawl API key.</strong> Under the{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Web Search
              </span>{" "}
              section, choose{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Outcrawl
              </span>{" "}
              as the provider and paste your API key. Vellum stores the key in
              your local secure store and never writes it to disk in plaintext.
            </li>
            <li>
              <strong>Try it.</strong> Start a new conversation and ask a
              question that needs fresh or hard-to-find information. Vellum
              calls Outcrawl under the hood and feeds the results back to the
              model in context.
            </li>
          </ol>
          <p className="mb-3 text-zinc-600 dark:text-zinc-400">
            Prefer the CLI? From any shell where the assistant daemon is
            running:
          </p>
          <div className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4">
            <pre className="font-[family-name:var(--font-dm-mono)] text-sm text-zinc-100">
              {`assistant keys set outcrawl <your-outcrawl-api-key>
assistant config set services.web-search.provider outcrawl`}
            </pre>
          </div>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Swap or revoke the key at any time with{" "}
            <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200">
              assistant keys delete outcrawl
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
              <strong>Result counts.</strong> Outcrawl returns up to twenty
              results per call. Vellum requests the count the assistant asked
              for and trims the response to it.
            </li>
            <li>
              <strong>Recency filters are not applied.</strong> Outcrawl search
              does not take a time window, so the freshness hint is ignored. Put
              a date or &quot;latest&quot; in the query when recency matters, or
              pick a provider that supports freshness filters.
            </li>
            <li>
              <strong>Fallback behavior.</strong> Outcrawl participates in the
              web search fallback chain after the other BYOK providers. The
              chain skips any provider without a key connected; if none are
              connected, the search returns an error. See the{" "}
              <Link
                href="/docs/key-concepts/web-search"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Web Search
              </Link>{" "}
              page for the full fallback rules.
            </li>
            <li>
              <strong>Billing.</strong> Outcrawl usage is billed in credits
              directly by Outcrawl under the account that owns the key,
              separately from Vellum credits.
            </li>
            <li>
              <strong>Privacy.</strong> Search queries leave your assistant and
              reach Outcrawl servers. Review the{" "}
              <Link
                href="https://outcrawl.ai/legal/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Outcrawl privacy policy
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
                href="https://outcrawl.ai/docs/api-reference/search"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Outcrawl Search API documentation
              </Link>
            </li>
            <li>
              <Link
                href="https://outcrawl.ai/pricing"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Outcrawl API keys and pricing
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
