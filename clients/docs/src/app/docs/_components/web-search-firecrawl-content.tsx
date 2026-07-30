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

export function WebSearchFirecrawlContent() {
  return (
    <>
      <DocsContent
        title="Firecrawl"
        breadcrumb="Docs / Key Concepts / Web Search / Firecrawl"
        subtitle="Web search and full-page scraping in one provider. Use Firecrawl in your Vellum assistant for clean, relevance-ranked results and markdown extraction from pages the built-in fetcher cannot read."
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Firecrawl is unusual among the web providers because it covers both jobs your
            assistant needs. As a search provider it returns clean, relevance-ranked results
            with an optional freshness filter. As a fetch provider it scrapes a specific URL
            through its hosted API and returns tidy markdown, including for JavaScript-rendered
            pages that the built-in fetcher cannot see.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            One Firecrawl key powers both paths. Set it as your web search provider, your web
            fetch provider, or both. When configured, Vellum routes the matching calls through
            Firecrawl and feeds the results back to your assistant in context, where the model
            can read snippets, open sources, or synthesize an answer.
          </p>
        </section>

        <section id="prerequisites" className="mt-12">
          <SectionHeading id="prerequisites" level={2}>
            Prerequisites
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              A running Vellum assistant. Cloud, self-hosted, or the macOS desktop app all work.
            </li>
            <li>
              A Firecrawl API key. Create one at{" "}
              <Link
                href="https://www.firecrawl.dev/app/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                firecrawl.dev
              </Link>
              . Keys start with{" "}
              <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200">
                fc-
              </code>
              .
            </li>
          </ul>
        </section>

        <section id="setup" className="mt-12">
          <SectionHeading id="setup" level={2}>
            Setup
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Firecrawl is BYOK (bring your own key). You stay in control of the key and pay
            Firecrawl directly for usage. The same key serves both web search and web fetch.
          </p>
          <ol className="mb-6 list-decimal space-y-3 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong>Open assistant settings.</strong>{" "}
              In Vellum, head to{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Settings &rarr; Models &amp; Services
              </span>
              .
            </li>
            <li>
              <strong>Add your Firecrawl API key.</strong>{" "}
              Under the <span className="font-medium text-zinc-900 dark:text-zinc-100">Web Search</span> section,
              choose <span className="font-medium text-zinc-900 dark:text-zinc-100">Firecrawl</span> as the provider and
              paste your API key. To use Firecrawl for single-page retrieval too, select it under
              the <span className="font-medium text-zinc-900 dark:text-zinc-100">Web Fetch</span> section as well.
              Vellum stores the key in your local secure store and never writes it to disk in plaintext.
            </li>
            <li>
              <strong>Try it.</strong>{" "}
              Start a new conversation and ask a question that needs fresh information, or point the
              assistant at a JavaScript-heavy page. Vellum calls Firecrawl under the hood and feeds
              the results back to the model in context.
            </li>
          </ol>
          <p className="mb-3 text-zinc-600 dark:text-zinc-400">
            Prefer the CLI? From any shell where the assistant is running:
          </p>
          <div className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4">
            <pre className="font-[family-name:var(--font-dm-mono)] text-sm text-zinc-100">
{`assistant keys set firecrawl fc-...
assistant config set services.web-search.provider firecrawl
assistant config set services.web-fetch.provider firecrawl`}
            </pre>
          </div>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            The third line is optional. Set it only if you want Firecrawl to handle single-page
            fetches as well as search. Swap or revoke the key at any time with{" "}
            <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200">
              assistant keys delete firecrawl
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
              <strong>Reach for Firecrawl when pages fight back.</strong>{" "}
              If your assistant keeps hitting JavaScript-rendered pages, snippets behind heavy client-side rendering, or
              sites the built-in fetcher returns empty on, Firecrawl&apos;s hosted scraper usually
              gets clean markdown back where a plain fetch fails.
            </li>
            <li>
              <strong>One key, both jobs.</strong>{" "}
              A single Firecrawl key powers web search and web fetch. Set it once and point both
              services at Firecrawl so usage and billing stay in one place.
            </li>
            <li>
              <strong>Fallback behavior.</strong>{" "}
              Firecrawl sits last in the web search fallback chain (after Perplexity, Brave, and
              Tavily). The chain skips any provider without a key connected; if none are connected,
              the search returns an error. See the{" "}
              <Link
                href={"/docs/key-concepts/web-search"}
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Web Search
              </Link>{" "}
              page for the full fallback rules.
            </li>
            <li>
              <strong>Billing.</strong>{" "}
              Firecrawl usage is billed directly by Firecrawl under the account that owns the key,
              separately from Vellum credits.
            </li>
            <li>
              <strong>Privacy.</strong>{" "}
              Queries and the URLs you fetch leave your assistant and reach Firecrawl servers. Review the{" "}
              <Link
                href="https://www.firecrawl.dev/privacy-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Firecrawl privacy policy
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
                href="https://docs.firecrawl.dev/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Firecrawl documentation
              </Link>
            </li>
            <li>
              <Link
                href="https://www.firecrawl.dev/app/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Firecrawl API key dashboard
              </Link>
            </li>
            <li>
              <Link
                href={"/docs/key-concepts/web-search"}
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
