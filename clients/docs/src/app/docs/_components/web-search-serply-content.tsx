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

export function WebSearchSerplyContent() {
  return (
    <>
      <DocsContent
        title="Serply"
        breadcrumb="Docs / Key Concepts / Web Search / Serply"
        subtitle="Google search results as JSON. Use Serply in your Vellum assistant when you want the same organic results a person would see in Google, with a title, link, and snippet for each."
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Serply is a search API that runs your query against Google and
            returns the organic results as structured JSON. Each result carries
            the page title, URL, and the snippet Google shows under it, in the
            order Google ranked them. Because the index is Google&apos;s, it
            covers the long tail of the web well and tracks news and recently
            changed pages closely.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            When configured, Vellum sends web search calls to Serply and feeds
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
              A Serply API key. Create one at{" "}
              <Link
                href="https://serply.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                serply.io
              </Link>
              . New accounts start with free credits and no card is required.
              Serply keys are opaque strings with no fixed prefix.
            </li>
          </ul>
        </section>

        <section id="setup" className="mt-12">
          <SectionHeading id="setup" level={2}>
            Setup
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Serply is BYOK (bring your own key). You stay in control of the key
            and pay Serply directly for usage.
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
              <strong>Add your Serply API key.</strong> Under the{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Web Search
              </span>{" "}
              section, choose{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Serply
              </span>{" "}
              as the provider and paste your API key. Vellum stores the key in
              your local secure store and never writes it to disk in plaintext.
            </li>
            <li>
              <strong>Try it.</strong> Start a new conversation and ask a
              question that needs fresh or hard-to-find information. Vellum
              calls Serply under the hood and feeds the Google results back to
              the model in context.
            </li>
          </ol>
          <p className="mb-3 text-zinc-600 dark:text-zinc-400">
            Prefer the CLI? From any shell where the assistant daemon is
            running:
          </p>
          <div className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4">
            <pre className="font-[family-name:var(--font-dm-mono)] text-sm text-zinc-100">
              {`assistant keys set serply <your-serply-api-key>
assistant config set services.web-search.provider serply`}
            </pre>
          </div>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Swap or revoke the key at any time with{" "}
            <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200">
              assistant keys delete serply
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
              <strong>Google operators work.</strong> Serply passes the query to
              Google unchanged, so{" "}
              <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200">
                site:
              </code>
              , quoted phrases, and the other Google search operators narrow
              results the same way they do in a browser.
            </li>
            <li>
              <strong>Result counts cap at ten.</strong> Serply returns one page
              of Google results per call, up to ten organic entries. Vellum
              requests at most ten and trims to the count the assistant asked
              for.
            </li>
            <li>
              <strong>Recency filters use Google&apos;s time filter.</strong>{" "}
              When the assistant asks for results from the past day, week,
              month, or year, Vellum passes that window to Serply as
              Google&apos;s time filter, so filtered searches behave the same as
              choosing a time range under Google&apos;s Tools menu.
            </li>
            <li>
              <strong>Fallback behavior.</strong> Serply participates in the web
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
              <strong>Billing.</strong> Serply usage is billed per request
              directly by Serply under the account that owns the key, separately
              from Vellum credits. Credits are prepaid and do not expire, and
              repeated identical requests served from Serply&apos;s cache are
              free.
            </li>
            <li>
              <strong>Privacy.</strong> Search queries leave your assistant and
              reach Serply servers. Review the{" "}
              <Link
                href="https://serply.io/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Serply privacy policy
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
                href="https://serply.io/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Serply API documentation
              </Link>
            </li>
            <li>
              <Link
                href="https://serply.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Serply API keys and pricing
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
