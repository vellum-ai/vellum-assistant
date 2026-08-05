"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "platform-domains", label: "Platform Domains", level: 2 },
  { id: "assistant-runtime", label: "Assistant Runtime", level: 3 },
  { id: "native-clients", label: "Native Clients", level: 3 },
  { id: "gateway", label: "Gateway", level: 3 },
  { id: "repository-structure", label: "Repository Structure", level: 2 },
  { id: "architecture-docs", label: "Architecture Docs", level: 2 },
];

export function DeveloperGuideArchitectureContent() {
  return (
    <>
      <DocsContent title="Architecture" breadcrumb="Docs / Developer Guide / Architecture">
        <p className="mb-8 text-zinc-600">
          The Vellum Assistant platform has three main domains that work together: a runtime that manages conversations and tools,
          a native client for macOS, and a gateway that handles all external communication.
        </p>

        <section id="platform-domains">
          <SectionHeading id="platform-domains" level={2}>
            Platform Domains
          </SectionHeading>

          <section id="assistant-runtime" className="mt-6">
            <SectionHeading id="assistant-runtime" level={3}>
              Assistant Runtime
            </SectionHeading>
            <p className="mb-2 text-zinc-600">
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">assistant/</code>
            </p>
            <p className="mb-4 text-zinc-600">
              Bun + TypeScript runtime that owns conversation history, attachment storage, and channel delivery state in a local
              SQLite database. Exposes a Unix domain socket for the native client, plus an
              HTTP API consumed by the gateway.
            </p>
          </section>

          <section id="native-clients" className="mt-6">
            <SectionHeading id="native-clients" level={3}>
              Native Clients
            </SectionHeading>
            <p className="mb-2 text-zinc-600">
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">clients/</code>
            </p>
            <p className="mb-4 text-zinc-600">
              Native macOS app built with Swift via <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">VellumAssistantShared</code>.
              A menu bar assistant with computer-use (accessibility + CGEvent), chat, and full tool access.
            </p>
          </section>

          <section id="gateway" className="mt-6">
            <SectionHeading id="gateway" level={3}>
              Gateway
            </SectionHeading>
            <p className="mb-2 text-zinc-600">
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">gateway/</code>
            </p>
            <p className="mb-4 text-zinc-600">
              Standalone Bun + TypeScript service that serves as the public ingress boundary for all external webhooks and callbacks.
              Owns Telegram integration end-to-end (receives webhooks, routes to assistants, delivers replies). Routes Twilio voice
              webhooks, handles OAuth callbacks, and optionally acts as an authenticated reverse proxy for the assistant runtime API.
            </p>
          </section>
        </section>

        <section id="repository-structure" className="mt-12">
          <SectionHeading id="repository-structure" level={2}>
            Repository Structure
          </SectionHeading>
          <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`/
├── assistant/            # Bun-based assistant runtime (runtime, CLI, HTTP API)
├── clients/              # Native macOS client (menu bar app)
├── gateway/              # Gateway service (Telegram, Twilio, OAuth, reverse proxy)
├── credential-executor/  # Credential Execution Service (isolated RPC boundary)
├── packages/             # Shared private packages (CES contracts, credential storage, egress proxy)
├── cli/                  # Vellum CLI
├── skills/               # Bundled skill definitions
├── benchmarking/         # Load testing scripts
├── scripts/              # Utility scripts (publishing, tunneling, releases)
├── meta/                 # Meta configuration
├── .claude/              # Claude Code slash commands and workflow tools
└── .github/              # GitHub Actions workflows`}
          </pre>
        </section>

        <section id="architecture-docs" className="mt-12">
          <SectionHeading id="architecture-docs" level={2}>
            Architecture Docs
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Detailed architecture docs are split by ownership domain, close to the code:
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700">
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Document</th>
                  <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">What&apos;s Covered</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">ARCHITECTURE.md</code></td>
                  <td className="py-2">Cross-system index — invariants, domain boundaries, data flow</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">assistant/ARCHITECTURE.md</code></td>
                  <td className="py-2">Runtime internals — conversation loop, tool dispatch, memory, scheduling</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">gateway/ARCHITECTURE.md</code></td>
                  <td className="py-2">Ingress boundary — webhooks, Telegram, Twilio, reverse proxy</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">clients/ARCHITECTURE.md</code></td>
                  <td className="py-2">Native macOS client — menu bar app</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">assistant/docs/architecture/security.md</code></td>
                  <td className="py-2">Security model — sandbox, credentials, permissions, secret handling</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><code className="text-xs">assistant/docs/architecture/memory.md</code></td>
                  <td className="py-2">Memory system — extraction, recall, provenance gates</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4"><code className="text-xs">assistant/docs/credential-execution-service.md</code></td>
                  <td className="py-2">CES — credential isolation, secure commands, RPC boundary</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
