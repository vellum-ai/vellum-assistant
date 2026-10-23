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

export function WebSearchYouContent() {
  return (
    <>
      <DocsContent
        title="You.com"
        breadcrumb="Docs / Key Concepts / Web Search / You.com"
        subtitle="Web search built for LLMs, with page snippets on every result. Use You.com in your Vellum assistant without a key on the free tier, or add a key for higher limits."
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            You.com Search returns web results as structured JSON built for
            LLMs. Each result carries the page title, URL, a short description,
            several query-relevant snippets pulled from the page, and the
            page&apos;s age when it is known.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            When configured, Vellum sends web search calls to You.com and feeds
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
              Nothing else to start. You.com works without a key on its free
              tier (100 searches a day, counted per IP address).
            </li>
            <li>
              Optional: a You.com API key for higher limits. Create one at{" "}
              <Link
                href="https://you.com/platform"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                you.com/platform
              </Link>
              .
            </li>
          </ul>
        </section>

        <section id="setup" className="mt-12">
          <SectionHeading id="setup" level={2}>
            Setup
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            You.com is keyless by default. Selecting it as the provider is
            enough. Adding a key switches Vellum to the keyed endpoint and lifts
            the free-tier cap; usage is then billed by You.com to the account
            that owns the key.
          </p>
          <ol className="mb-6 list-decimal space-y-3 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong>Open assistant settings.</strong> In Vellum, head to
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Settings &rarr; Models &amp; Services
              </span>
              .
            </li>
            <li>
              <strong>Choose You.com.</strong> Under the
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Web Search
              </span>
              section, choose
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                You.com
              </span>
              as the provider. Leave the API key empty to use the free tier, or
              paste a key. Vellum stores the key in your local secure store and
              never writes it to disk in plaintext.
            </li>
            <li>
              <strong>Try it.</strong> Start a new conversation and ask a
              question that needs fresh information. Vellum calls You.com under
              the hood and feeds the results back to the model in context.
            </li>
          </ol>
          <p className="mb-3 text-zinc-600 dark:text-zinc-400">
            Prefer the CLI? From any shell where the assistant daemon is
            running:
          </p>
          <div className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4">
            <pre className="font-[family-name:var(--font-dm-mono)] text-sm text-zinc-100">
              {`assistant config set services.web-search.provider you
# optional, lifts the free-tier cap
assistant keys set you <your-you-api-key>`}
            </pre>
          </div>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            The CLI also reads the key from the{" "}
            <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200">
              YDC_API_KEY
            </code>{" "}
            environment variable. Remove a stored key with{" "}
            <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200">
              assistant keys delete you
            </code>
            ; searches fall back to the free tier.
          </p>
        </section>

        <section id="best-practices" className="mt-12">
          <SectionHeading id="best-practices" level={2}>
            Best practices
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong>Free-tier limits.</strong> Keyless searches are capped at
              100 a day per IP address. Past the cap You.com returns a rate
              limit error until the window resets. Add a key if your assistant
              searches often or shares an IP with other users.
            </li>
            <li>
              <strong>Recency filters.</strong> When the assistant asks for
              results from the past day, week, month, or year, Vellum passes
              that window to You.com as its freshness filter.
            </li>
            <li>
              <strong>Fallback behavior.</strong> You.com runs only when you
              select it. Because it works without a key, it is never picked
              automatically as a fallback for another provider. See the{" "}
              <Link
                href="/docs/key-concepts/web-search"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                Web Search
              </Link>{" "}
              page for the full fallback rules.
            </li>
            <li>
              <strong>Privacy.</strong> Search queries leave your assistant and
              reach You.com servers. Review the{" "}
              <Link
                href="https://you.com/legal/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                You.com privacy policy
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
                href="https://docs.you.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                You.com API documentation
              </Link>
            </li>
            <li>
              <Link
                href="https://you.com/platform"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline hover:text-emerald-800"
              >
                You.com API keys and pricing
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
