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

export function WebSearchPerplexityContent() {
  return (
    <>
      <DocsContent
        title="Perplexity"
        breadcrumb="Docs / Key Concepts / Web Search / Perplexity"
        subtitle="AI-powered search with synthesized answers and inline citations. Use Perplexity as a web search provider in your Vellum assistant for conversational, citation-grade results."
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Perplexity is a search engine that uses large language models to synthesize
            answers from real-time web sources. Instead of returning a list of links,
            it produces a concise answer with inline citations, making it ideal for
            assistant workflows that need to explain or summarize current information.
          </p>
          <p className="mb-0 text-zinc-600">
            When configured as your web search provider, Vellum routes queries through
            the Perplexity API and feeds the synthesized answer (with its source citations)
            back to your assistant. The model can then quote from, verify, or expand on
            the answer without needing to scrape individual pages.
          </p>
        </section>

        <section id="prerequisites" className="mt-12">
          <SectionHeading id="prerequisites" level={2}>
            Prerequisites
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              A running Vellum assistant. Cloud, self-hosted, or the macOS desktop app all work.
            </li>
            <li>
              A Perplexity API key. Create one at{" "}
              <Link
                href="https://www.perplexity.ai/settings/api"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                perplexity.ai/settings/api
              </Link>
              . Keys start with{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-800">
                pplx-
              </code>
              .
            </li>
          </ul>
        </section>

        <section id="setup" className="mt-12">
          <SectionHeading id="setup" level={2}>
            Setup
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Perplexity is BYOK (bring your own key). You stay in control of the key and pay Perplexity directly for usage.
          </p>
          <ol className="mb-6 list-decimal space-y-3 pl-6 text-zinc-600">
            <li>
              <strong>Open assistant settings.</strong>{" "}
              In Vellum, head to{" "}
              <span className="font-medium text-zinc-900">
                Settings &rarr; Models &amp; Services
              </span>
              .
            </li>
            <li>
              <strong>Add your Perplexity API key.</strong>{" "}
              Under the <span className="font-medium text-zinc-900">Web Search</span> section,
              choose <span className="font-medium text-zinc-900">Perplexity</span> as the provider and
              paste your API key. Vellum stores the key in your local secure store and never
              writes it to disk in plaintext.
            </li>
            <li>
              <strong>Ask something current.</strong>{" "}
              Start a new conversation and ask a question that needs fresh information. Vellum
              calls Perplexity under the hood and feeds the synthesized answer back to the model
              in context.
            </li>
          </ol>
          <p className="mb-3 text-zinc-600">
            Prefer the CLI? Two commands from any shell where the assistant is running:
          </p>
          <div className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4">
            <pre className="font-[family-name:var(--font-dm-mono)] text-sm text-zinc-100">
{`assistant keys set perplexity pplx-...
assistant config set services.web-search.provider perplexity`}
            </pre>
          </div>
          <p className="mb-0 text-zinc-600">
            Swap or revoke the key at any time with{" "}
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-800">
              assistant keys delete perplexity
            </code>
            .
          </p>
        </section>

        <section id="best-practices" className="mt-12">
          <SectionHeading id="best-practices" level={2}>
            Best practices
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Pick Perplexity when you want synthesized answers.</strong>{" "}
              Perplexity excels at producing a single coherent answer with citations.
              For raw search results or relevance-scored snippets, consider Tavily or Brave.
            </li>
            <li>
              <strong>One key per workspace.</strong>{" "}
              Reuse the same Perplexity key across your assistants so usage and billing
              stay in one place on the Perplexity dashboard.
            </li>
            <li>
              <strong>Fallback behavior.</strong>{" "}
              If Perplexity is unavailable, the assistant falls through the rest of the web search
              chain (Brave, then Tavily, then Provider Native). See the{" "}
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
              Perplexity usage is billed directly by Perplexity under the account that owns the key,
              separately from Vellum credits.
            </li>
            <li>
              <strong>Privacy.</strong>{" "}
              Queries leave your assistant and reach Perplexity&apos;s servers. Review the{" "}
              <Link
                href="https://www.perplexity.ai/hub/legal/privacy-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Perplexity privacy policy
              </Link>{" "}
              for details.
            </li>
          </ul>
        </section>

        <section id="resources" className="mt-12">
          <SectionHeading id="resources" level={2}>
            Resources
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <Link
                href="https://docs.perplexity.ai/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Perplexity API documentation
              </Link>
            </li>
            <li>
              <Link
                href="https://www.perplexity.ai/settings/api"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Perplexity API key dashboard
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
