import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";
import { getIntegrationBySlug } from "@/lib/integrations-data";

const TOC_ITEMS = [
  { id: "what-it-does", label: "What it does", level: 2 as const },
  { id: "prerequisites", label: "Prerequisites", level: 2 as const },
  { id: "setup", label: "Setup", level: 2 as const },
  { id: "best-practices", label: "Best practices", level: 2 as const },
  { id: "resources", label: "Resources", level: 2 as const },
];

/**
 * Hand-rolled content for the Tavily integration. Structure mirrors
 * docs.tavily.com/documentation/integrations/vellum so the two sides of the
 * integration read consistently. Tavily is API-key (BYOK), not OAuth.
 *
 * The deeper concept page at /docs/key-concepts/web-search covers all four
 * providers and the fallback chain; this page is the focused "I want to
 * connect Tavily" entry point.
 */
export function IntegrationsTavilyContent() {
  const integration = getIntegrationBySlug("tavily");

  return (
    <>
      <DocsContent
        title={integration?.name ?? "Tavily"}
        breadcrumb="Docs / Integrations / Tavily"
        subtitle="Real-time web search built for AI agents. Use Tavily as the web search provider in your Vellum assistant for citation-grade, relevance-scored results."
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Vellum ships with a built-in web search capability that connects your assistant&apos;s
            conversations to real-time information from the open web. Tavily is one of the
            supported providers, and the one we recommend when you want results shaped for agents
            rather than humans.
          </p>
          <p className="mb-0 text-zinc-600">
            Each Tavily result comes with a relevance score, the URL, the title, and a
            pre-extracted content block, so the assistant can quote from a page without a separate
            fetch step. Once configured, Vellum routes web search queries through the Tavily API
            so the model can answer questions with up-to-date sources instead of guessing from
            training data.
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
              A Tavily API key. Create one at{" "}
              <Link
                href="https://app.tavily.com/home"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                app.tavily.com
              </Link>
              . Keys start with{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-800">
                tvly-
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
            Tavily is BYOK (bring your own key). You stay in control of the key and pay Tavily
            directly for usage.
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
              <strong>Add your Tavily API key.</strong>{" "}
              Under the <span className="font-medium text-zinc-900">Web Search</span> section,
              choose <span className="font-medium text-zinc-900">Tavily</span> as the provider and
              paste your API key. Vellum stores the key in your local secure store and never
              writes it to disk in plaintext.
            </li>
            <li>
              <strong>Ask something current.</strong>{" "}
              Start a new conversation and ask a question that needs fresh information. Vellum
              calls Tavily under the hood and feeds the results back to the model in context.
            </li>
          </ol>
          <p className="mb-3 text-zinc-600">
            Prefer the CLI? Two commands from any shell where the assistant daemon is running:
          </p>
          <div className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4">
            <pre className="font-[family-name:var(--font-dm-mono)] text-sm text-zinc-100">
{`assistant keys set tavily tvly-...
assistant config set services.web-search.provider tavily`}
            </pre>
          </div>
          <p className="mb-0 text-zinc-600">
            Swap or revoke the key at any time with{" "}
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-800">
              assistant keys delete tavily
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
              <strong>Pick Tavily when you want agent-optimized results.</strong>{" "}
              Tavily returns relevance-scored, LLM-friendly snippets that work especially well
              inside an assistant loop. For raw HTML or page scraping, use a different provider.
            </li>
            <li>
              <strong>One key per workspace.</strong>{" "}
              Reuse the same Tavily key across your assistants and other tools so usage and
              billing stay in one place on the Tavily dashboard.
            </li>
            <li>
              <strong>Dev vs production keys.</strong>{" "}
              Keys that start with{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-800">
                tvly-dev-
              </code>{" "}
              are free-tier development keys with lower rate limits. Upgrade to a paid plan for
              production workloads.
            </li>
            <li>
              <strong>Fallback behavior.</strong>{" "}
              If Tavily is unavailable, the assistant falls through the rest of the web search
              chain (Perplexity, Brave, then Provider Native). See the{" "}
              <Link
                href="/docs/key-concepts/web-search"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Web Search
              </Link>{" "}
              page for the full fallback rules.
            </li>
            <li>
              <strong>Billing.</strong>{" "}
              Tavily usage is billed directly by Tavily under the account that owns the key,
              separately from Vellum credits.
            </li>
            <li>
              <strong>Privacy.</strong>{" "}
              Queries leave your assistant and reach Tavily&apos;s servers. Review the{" "}
              <Link
                href="https://tavily.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Tavily privacy policy
              </Link>{" "}
              before connecting it to a workspace with sensitive prompts.
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
                href="https://app.tavily.com/home"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Tavily API dashboard
              </Link>{" "}
              to create and manage keys.
            </li>
            <li>
              <Link
                href="https://docs.tavily.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Tavily documentation
              </Link>{" "}
              for API reference and advanced usage.
            </li>
            <li>
              <Link
                href="https://docs.tavily.com/documentation/integrations/vellum"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Tavily &harr; Vellum guide
              </Link>{" "}
              on the Tavily docs site.
            </li>
            <li>
              <Link
                href="/docs/key-concepts/web-search"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Vellum Web Search reference
              </Link>{" "}
              for the full provider matrix and fallback chain.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
