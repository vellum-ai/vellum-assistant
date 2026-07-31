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

export function WebSearchBraveContent() {
  return (
    <>
      <DocsContent
        title="Brave Search"
        breadcrumb="Docs / Key Concepts / Web Search / Brave Search"
        subtitle="Privacy-first web search with an independent index. Use Brave Search as a web search provider in your Vellum assistant for ad-free, tracking-free results."
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Brave Search is an independent search engine with its own index, built by the
            team behind the Brave browser. It does not track users, profile queries, or
            show ads. For assistants that need privacy-first web search with transparent
            sourcing, Brave is a strong choice.
          </p>
          <p className="mb-0 text-zinc-600">
            When configured as your web search provider, Vellum routes queries through the
            Brave Search API and feeds the ranked results back to your assistant. The model
            can then read snippets, visit sources, or synthesize an answer from the retrieved
            pages.
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
              A Brave Search API key. Create one at{" "}
              <Link
                href="https://api.search.brave.com/app/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                api.search.brave.com
              </Link>
              . Keys start with{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-800">
                BSA
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
            Brave Search is BYOK (bring your own key). You stay in control of the key and pay Brave directly for usage.
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
              <strong>Add your Brave Search API key.</strong>{" "}
              Under the <span className="font-medium text-zinc-900">Web Search</span> section,
              choose <span className="font-medium text-zinc-900">Brave Search</span> as the provider and
              paste your API key. Vellum stores the key in your local secure store and never
              writes it to disk in plaintext.
            </li>
            <li>
              <strong>Ask something current.</strong>{" "}
              Start a new conversation and ask a question that needs fresh information. Vellum
              calls Brave Search under the hood and feeds the results back to the model in context.
            </li>
          </ol>
          <p className="mb-3 text-zinc-600">
            Prefer the CLI? Two commands from any shell where the assistant is running:
          </p>
          <div className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4">
            <pre className="font-[family-name:var(--font-dm-mono)] text-sm text-zinc-100">
{`assistant keys set brave BSA...
assistant config set services.web-search.provider brave`}
            </pre>
          </div>
          <p className="mb-0 text-zinc-600">
            Swap or revoke the key at any time with{" "}
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-800">
              assistant keys delete brave
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
              <strong>Pick Brave when privacy matters.</strong>{" "}
              Brave Search has its own independent index and does not track or profile queries.
              For assistants handling sensitive topics, this is the most privacy-conscious option.
            </li>
            <li>
              <strong>One key per workspace.</strong>{" "}
              Reuse the same Brave Search key across your assistants so usage and billing stay
              in one place on the Brave dashboard.
            </li>
            <li>
              <strong>Fallback behavior.</strong>{" "}
              If Brave Search is unavailable, the assistant falls through the rest of the web search
              chain (Perplexity, Tavily, then Provider Native). See the{" "}
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
              Brave Search usage is billed directly by Brave under the account that owns the key,
              separately from Vellum credits.
            </li>
            <li>
              <strong>Privacy.</strong>{" "}
              Queries leave your assistant and reach Brave Search servers. Review the{" "}
              <Link
                href="https://search.brave.com/help/privacy-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Brave Search privacy policy
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
                href="https://api.search.brave.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Brave Search API documentation
              </Link>
            </li>
            <li>
              <Link
                href="https://api.search.brave.com/app/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Brave Search API key dashboard
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
