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

export function WebSearchSpecstreamContent() {
  return (
    <>
      <DocsContent
        title="SpecStream"
        breadcrumb="Docs / Key Concepts / Web Search / SpecStream"
        subtitle="SpecStream is the live web data engine. Use its Search API in your Vellum assistant for ranked web results with a title, link, and snippet for each."
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            SpecStream is the live web data engine. Its Search API takes a query
            in everyday words, in any language, searches the live web, and
            returns the results as structured JSON in rank order. Each result
            carries the page title, URL, and a snippet, plus the date the page
            was published when the page states one.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            When configured, Vellum sends web search calls to SpecStream and
            feeds the results back to your assistant in context. The model can
            cite the snippets, open a source with web fetch, or synthesize an
            answer across several results.
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
              A SpecStream API key. Create one under Agents &amp; API at{" "}
              <Link
                href="https://specstream.ai/workspace"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                specstream.ai/workspace
              </Link>
              . New accounts start with $10 of credit.
            </li>
          </ul>
        </section>

        <section id="setup" className="mt-12">
          <SectionHeading id="setup" level={2}>
            Setup
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            SpecStream is BYOK (bring your own key). You stay in control of the
            key and pay SpecStream directly for usage.
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
              <strong>Add your SpecStream API key.</strong> Under the{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Web Search
              </span>{" "}
              section, choose{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                SpecStream
              </span>{" "}
              as the provider and paste your API key. Vellum stores the key in
              your local secure store and never writes it to disk in plaintext.
            </li>
            <li>
              <strong>Try it.</strong> Start a new conversation and ask a
              question that needs fresh or hard-to-find information. Vellum
              calls SpecStream under the hood and feeds the results back to the
              model in context.
            </li>
          </ol>
          <p className="mb-3 text-zinc-600 dark:text-zinc-400">
            Prefer the CLI? From any shell where the assistant daemon is
            running:
          </p>
          <div className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4">
            <pre className="font-[family-name:var(--font-dm-mono)] text-sm text-zinc-100">
              {`assistant keys set specstream <your-specstream-api-key>
assistant config set services.web-search.provider specstream`}
            </pre>
          </div>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Swap or revoke the key at any time with{" "}
            <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200">
              assistant keys delete specstream
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
              <strong>Phrases and operators work.</strong> Quoted phrases are
              searched as phrases, and{" "}
              <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200">
                site:
              </code>
              ,{" "}
              <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200">
                -word
              </code>
              , and{" "}
              <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200">
                filetype:
              </code>{" "}
              narrow results the same way they do in a search engine.
            </li>
            <li>
              <strong>Result counts cap at ten.</strong> One SpecStream search
              covers up to ten results. Vellum requests at most ten and trims to
              the count the assistant asked for.
            </li>
            <li>
              <strong>No recency filter.</strong> The Search API has no date
              filter, so Vellum does not pass the past day, week, month, or year
              window to SpecStream. Results show the published date when the
              page states one.
            </li>
            <li>
              <strong>Fallback behavior.</strong> SpecStream participates in the
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
              <strong>Billing.</strong> SpecStream usage is billed per search
              directly by SpecStream under the account that owns the key,
              separately from Vellum credits, at $5 per 1,000 searches. A search
              that returns no results is not charged.
            </li>
            <li>
              <strong>Privacy.</strong> Search queries leave your assistant and
              reach SpecStream servers. Review the{" "}
              <Link
                href="https://specstream.ai/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                SpecStream privacy policy
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
                href="https://specstream.ai/docs/search-api"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                SpecStream Search API documentation
              </Link>
            </li>
            <li>
              <Link
                href="https://specstream.ai/workspace"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                SpecStream API keys
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
