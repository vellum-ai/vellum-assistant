"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const KIND_STYLES: Record<string, string> = {
  Managed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300",
  BYOK: "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300",
};

function KindBadge({ kind }: { kind: "Managed" | "BYOK" }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${KIND_STYLES[kind]}`}>
      {kind}
    </span>
  );
}

const TOC_ITEMS = [
  { id: "overview", label: "Overview", level: 2 },
  { id: "providers", label: "Providers", level: 2 },
  { id: "choosing-a-provider", label: "Choosing a provider", level: 2 },
  { id: "configuring", label: "Configuring web search", level: 2 },
  { id: "fallback", label: "Fallback behavior", level: 2 },
  { id: "billing", label: "Billing", level: 2 },
  { id: "tavily", label: "Tavily Integration", level: 2 },
  { id: "perplexity", label: "Perplexity Integration", level: 2 },
  { id: "brave", label: "Brave Search Integration", level: 2 },
  { id: "firecrawl", label: "Firecrawl Integration", level: 2 },
];

export function WebSearchContent() {
  return (
    <>
      <DocsContent
        title="Web Search"
        breadcrumb="Docs / Key Concepts / Web Search"
        eyebrow="Key Concepts"
        subtitle="How your assistant looks things up online: the six built-in providers, the fallback chain, and how each one is billed."
      >
        {/* ------------------------------------------------------------------ */}
        {/* Overview                                                             */}
        {/* ------------------------------------------------------------------ */}
        <section id="overview">
          <SectionHeading id="overview" level={2}>
            Overview
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Web search lets your assistant pull live information from the
            internet to answer questions, verify claims, and ground its
            responses in current sources. Whenever a conversation, scheduled
            task, or skill needs information that isn&apos;t in your workspace,
            the assistant can call out to a search provider, read the results,
            and cite the sources it used.
          </p>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            You control which provider runs that search and how it&apos;s
            billed. Vellum&apos;s managed search works out of the box on your
            platform account, your inference provider&apos;s native search can
            handle it in-model, or you can connect your own API key for a
            dedicated search engine like Perplexity, Brave Search, Tavily, or
            Firecrawl.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Providers                                                            */}
        {/* ------------------------------------------------------------------ */}
        <section id="providers" className="mt-12">
          <SectionHeading id="providers" level={2}>
            Providers
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Six providers ship with every workspace. Managed providers need no
            API key and bill through your Vellum account; BYOK providers call
            the vendor directly with a key you connect and bill you there.
          </p>
          <div className="overflow-x-auto">
            <table className="mb-4 w-full text-sm text-stone-600 dark:text-stone-400">
              <thead>
                <tr className="border-b border-stone-200 dark:border-moss-600">
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Provider
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Kind
                  </th>
                  <th className="pb-3 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50 dark:[&>tr:nth-child(even)]:bg-moss-900/30">
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Vellum
                  </td>
                  <td className="py-3 pr-4"><KindBadge kind="Managed" /></td>
                  <td className="py-3">
                    Searches run through Vellum&apos;s managed search service.
                    No setup, no API key. Metered from your Vellum account
                    balance.
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Provider Native
                  </td>
                  <td className="py-3 pr-4"><KindBadge kind="Managed" /></td>
                  <td className="py-3">
                    Hands the search to the inference provider, so quality and
                    freshness follow whichever LLM you have selected. When the
                    selected model has no native search, the assistant falls
                    back to any connected search key, then to Vellum&apos;s
                    managed search.
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Perplexity
                  </td>
                  <td className="py-3 pr-4"><KindBadge kind="BYOK" /></td>
                  <td className="py-3">
                    Synthesized answers with inline citations. Default first
                    choice in the fallback chain. Pulls from the Perplexity
                    Search API.
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Brave Search
                  </td>
                  <td className="py-3 pr-4"><KindBadge kind="BYOK" /></td>
                  <td className="py-3">
                    Independent index, no tracking, supports freshness
                    filtering. Good default for privacy-leaning workspaces.
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Tavily
                  </td>
                  <td className="py-3 pr-4"><KindBadge kind="BYOK" /></td>
                  <td className="py-3">
                    Search API designed for AI agents. Returns scored results
                    with extracted content blocks.
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Firecrawl
                  </td>
                  <td className="py-3 pr-4"><KindBadge kind="BYOK" /></td>
                  <td className="py-3">
                    Search plus full-page scraping. Returns clean markdown,
                    including for JavaScript-rendered pages. One key also powers
                    web fetch.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            For each BYOK provider you connect, your assistant stores the key
            locally and uses it for every web search until you disconnect or
            switch providers. Provider privacy policies:{" "}
            <Link
              href="https://www.perplexity.ai/hub/legal/privacy-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              Perplexity
            </Link>
            ,{" "}
            <Link
              href="https://search.brave.com/help/privacy-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              Brave
            </Link>
            ,{" "}
            <Link
              href="https://tavily.com/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              Tavily
            </Link>
            ,{" "}
            <Link
              href="https://www.firecrawl.dev/privacy-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              Firecrawl
            </Link>
            .
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Choosing a provider                                                  */}
        {/* ------------------------------------------------------------------ */}
        <section id="choosing-a-provider" className="mt-12">
          <SectionHeading id="choosing-a-provider" level={2}>
            Choosing a provider
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Side-by-side comparison across the dimensions that usually matter.
          </p>
          <div className="overflow-x-auto">
            <table className="mb-4 w-full text-sm text-stone-600 dark:text-stone-400">
              <thead>
                <tr className="border-b border-stone-200 dark:border-moss-600">
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Dimension
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Vellum
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Provider Native
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Perplexity
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Brave
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Tavily
                  </th>
                  <th className="pb-3 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Firecrawl
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50 dark:[&>tr:nth-child(even)]:bg-moss-900/30">
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Setup</td>
                  <td className="py-3 pr-4">None. Works out of the box.</td>
                  <td className="py-3 pr-4">None. Works out of the box.</td>
                  <td className="py-3 pr-4">API key required</td>
                  <td className="py-3 pr-4">API key required</td>
                  <td className="py-3 pr-4">API key required</td>
                  <td className="py-3">API key required</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Billing</td>
                  <td className="py-3 pr-4">Vellum credits, metered per search</td>
                  <td className="py-3 pr-4">Bundled with inference (Vellum credits)</td>
                  <td className="py-3 pr-4">Direct to Perplexity</td>
                  <td className="py-3 pr-4">Direct to Brave</td>
                  <td className="py-3 pr-4">Direct to Tavily</td>
                  <td className="py-3">Direct to Firecrawl</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Result style</td>
                  <td className="py-3 pr-4">Raw ranked results (title, URL, snippet)</td>
                  <td className="py-3 pr-4">Depends on the LLM you selected</td>
                  <td className="py-3 pr-4">Synthesized answer with inline citations</td>
                  <td className="py-3 pr-4">Raw ranked results (title, URL, snippet)</td>
                  <td className="py-3 pr-4">Scored results with extracted content blocks</td>
                  <td className="py-3">Clean markdown, full pages included</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Index source</td>
                  <td className="py-3 pr-4">Vellum&apos;s managed search service</td>
                  <td className="py-3 pr-4">Whatever the LLM provider uses</td>
                  <td className="py-3 pr-4">Aggregates multiple search engines</td>
                  <td className="py-3 pr-4">Independent crawl, not Google or Bing</td>
                  <td className="py-3 pr-4">Aggregates multiple search engines</td>
                  <td className="py-3">Aggregates multiple search engines</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Freshness control</td>
                  <td className="py-3 pr-4">Supported (day / week / month / year)</td>
                  <td className="py-3 pr-4">Not exposed</td>
                  <td className="py-3 pr-4">Not exposed</td>
                  <td className="py-3 pr-4">Supported (day / week / month / year)</td>
                  <td className="py-3 pr-4">Supported</td>
                  <td className="py-3">Supported</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Privacy</td>
                  <td className="py-3 pr-4">Processed by Vellum&apos;s search infrastructure</td>
                  <td className="py-3 pr-4">Subject to LLM provider terms</td>
                  <td className="py-3 pr-4">Standard SaaS</td>
                  <td className="py-3 pr-4">No query tracking</td>
                  <td className="py-3 pr-4">Standard SaaS</td>
                  <td className="py-3">Standard SaaS</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Agent ergonomics</td>
                  <td className="py-3 pr-4">General-purpose search shape</td>
                  <td className="py-3 pr-4">Hidden behind the LLM</td>
                  <td className="py-3 pr-4">Pre-synthesized, agent can quote directly</td>
                  <td className="py-3 pr-4">General-purpose search shape</td>
                  <td className="py-3 pr-4">Built for agents (scores, content blocks, raw content)</td>
                  <td className="py-3">Search plus full-page scrape, reads JS-rendered pages</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">Best for</td>
                  <td className="py-3 pr-4">Zero-setup search billed to one account</td>
                  <td className="py-3 pr-4">Default setups, low overhead</td>
                  <td className="py-3 pr-4">Cited answers in chat</td>
                  <td className="py-3 pr-4">Privacy-leaning workspaces</td>
                  <td className="py-3 pr-4">Agentic workflows with extraction</td>
                  <td className="py-3">Scraping JS-heavy pages; search and fetch from one key</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            If you&apos;re unsure, start on Vellum or Provider Native and
            switch only when you hit a concrete reason to.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Configuring                                                          */}
        {/* ------------------------------------------------------------------ */}
        <section id="configuring" className="mt-12">
          <SectionHeading id="configuring" level={2}>
            Configuring web search
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Web search is configured in{" "}
            <strong>Settings &rarr; AI &rarr; Web Search</strong>.
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-stone-600 dark:text-stone-400 marker:text-stone-400 dark:marker:text-stone-500">
            <li>
              Choose a <strong>provider</strong> from the dropdown. Vellum and
              Provider Native need no further setup.
            </li>
            <li>
              For a BYOK provider (Perplexity, Brave, Tavily, or Firecrawl),
              paste your API key into the field below the dropdown. Keys are
              stored locally on the device that runs your assistant.
            </li>
            <li>
              Optionally connect keys for more than one BYOK provider. The
              extras become fallbacks if the primary provider fails or runs
              out of quota. See{" "}
              <Link href="#fallback" className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300">
                Fallback behavior
              </Link>{" "}
              below.
            </li>
          </ol>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Changing the provider takes effect immediately for the next
            search; in-flight searches finish on the previously configured
            provider.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Fallback behavior                                                    */}
        {/* ------------------------------------------------------------------ */}
        <section id="fallback" className="mt-12">
          <SectionHeading id="fallback" level={2}>
            Fallback behavior
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            On <strong>Vellum</strong>, there is no fallback: search errors
            (including an exhausted account balance) surface directly so your
            searches are never silently rerouted to a key you pay for
            elsewhere. On <strong>Provider Native</strong>, the model&apos;s
            own hosted search runs first, then any connected search keys, then
            Vellum&apos;s managed search. On a <strong>BYOK provider</strong>,
            your assistant tries the provider you selected first; if it has no
            key configured or its request fails with a retryable error, the
            daemon walks the fallback chain in this order:
          </p>
          <ol className="mb-4 list-decimal space-y-1 pl-6 text-stone-600 dark:text-stone-400 marker:text-stone-400 dark:marker:text-stone-500">
            <li>Perplexity</li>
            <li>Brave Search</li>
            <li>Tavily</li>
            <li>Firecrawl</li>
          </ol>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            The chain skips any provider that doesn&apos;t have a key
            connected. If none of them have keys, the search returns an error
            and the assistant tells you it couldn&apos;t reach the web.
            Connecting more than one BYOK key is the simplest way to keep
            search resilient when an upstream provider has an outage.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Billing                                                              */}
        {/* ------------------------------------------------------------------ */}
        <section id="billing" className="mt-12">
          <SectionHeading id="billing" level={2}>
            Billing
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Web search is one of four chargeable categories in the Vellum
            platform, alongside LLM inference, image generation, and paid
            third-party APIs.
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400 marker:text-stone-400 dark:marker:text-stone-500">
            <li>
              On <strong>Vellum</strong>, each search is metered from your
              Vellum account balance.
            </li>
            <li>
              On <strong>Provider Native</strong>, search cost is bundled into
              the inference call that triggered it. You pay Vellum credits the
              same way you pay for any other LLM request.
            </li>
            <li>
              On a <strong>BYOK provider</strong>, the search vendor bills you
              directly under your account with them. Vellum doesn&apos;t mark
              up or proxy these requests.
            </li>
          </ul>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            For pricing details and credit denominations, see the{" "}
            <Link
              href="/docs/pricing"
              className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              pricing page
            </Link>
            .
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Tavily Integration                                                   */}
        {/* ------------------------------------------------------------------ */}
        <section id="tavily" className="mt-12">
          <SectionHeading id="tavily" level={2}>
            Tavily Integration
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Tavily is a search API designed specifically for AI agents. For a
            step-by-step walkthrough of connecting your Tavily API key, provider
            configuration, and advanced usage, see the{" "}
            <Link
              href="/docs/key-concepts/web-search/tavily"
              className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              Tavily integration page
            </Link>
            .
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Perplexity Integration                                               */}
        {/* ------------------------------------------------------------------ */}
        <section id="perplexity" className="mt-12">
          <SectionHeading id="perplexity" level={2}>
            Perplexity Integration
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Perplexity is an AI-powered search engine that synthesizes answers with inline
            citations. For a step-by-step walkthrough of connecting your Perplexity API key,
            provider configuration, and advanced usage, see the{" "}
            <Link
              href="/docs/key-concepts/web-search/perplexity"
              className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              Perplexity integration page
            </Link>
            .
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Brave Search Integration                                             */}
        {/* ------------------------------------------------------------------ */}
        <section id="brave" className="mt-12">
          <SectionHeading id="brave" level={2}>
            Brave Search Integration
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Brave Search is a privacy-first web search engine with an independent index.
            For a step-by-step walkthrough of connecting your Brave Search API key, provider
            configuration, and advanced usage, see the{" "}
            <Link
              href="/docs/key-concepts/web-search/brave"
              className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              Brave Search integration page
            </Link>
            .
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Firecrawl Integration                                                */}
        {/* ------------------------------------------------------------------ */}
        <section id="firecrawl" className="mt-12">
          <SectionHeading id="firecrawl" level={2}>
            Firecrawl Integration
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Firecrawl combines web search with full-page scraping, returning clean
            markdown even for JavaScript-rendered pages, and a single key powers both
            web search and web fetch. For a step-by-step walkthrough of connecting your
            Firecrawl API key, provider configuration, and advanced usage, see the{" "}
            <Link
              href="/docs/key-concepts/web-search/firecrawl"
              className="text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              Firecrawl integration page
            </Link>
            .
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
