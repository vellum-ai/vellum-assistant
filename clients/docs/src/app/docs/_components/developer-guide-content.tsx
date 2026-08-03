"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";

const GUIDES = [
  {
    href: "/docs/developer-guide/get-started",
    title: "Get Started",
    description: "Developer on-ramp: repo layout, local dev setup, CLI, HTTP API, and SSE event stream.",
  },
  {
    href: "/docs/developer-guide/architecture",
    title: "Architecture",
    description: "Platform domains, repo structure, and how the runtime, clients, and gateway fit together.",
  },
  {
    href: "/docs/developer-guide/security",
    title: "Security & Permissions",
    description: "Sandbox model, credential storage, trust rules, and permission modes.",
  },
  {
    href: "/docs/developer-guide/features",
    title: "Features & Capabilities",
    description: "Integrations, dynamic skill authoring, browser automation, attachments, and media embeds.",
  },
  {
    href: "/docs/developer-guide/api",
    title: "API & Communication",
    description: "SSE event stream, event payloads, connection management, and remote access via SSH.",
  },
  {
    href: "/docs/developer-guide/development-workflow",
    title: "Development Workflow",
    description: "Claude Code slash commands, parallel PR execution, review loops, and the release pipeline.",
  },

];

export function DeveloperGuideContent() {
  return (
    <DocsContent title="Developer Guide" breadcrumb="Docs / Developer Guide">
      <p className="mb-8 text-zinc-600">
        Technical reference for contributors and developers working on the Vellum Assistant platform.
        These docs cover architecture, security internals, the API surface, and the agent-driven development workflow.
      </p>

      <div className="grid gap-4">
        {GUIDES.map((guide) => (
          <Link
            key={guide.href}
            href={guide.href as never}
            className="group block rounded-xl border border-zinc-200 p-5 no-underline transition-all hover:border-emerald-300 hover:shadow-sm dark:border-zinc-700 dark:hover:border-emerald-600"
          >
            <h3 className="mb-1 text-base font-semibold text-zinc-900 group-hover:text-emerald-600 dark:text-zinc-100 dark:group-hover:text-emerald-400">
              {guide.title}
            </h3>
            <p className="m-0 text-sm text-zinc-500 dark:text-zinc-400">
              {guide.description}
            </p>
          </Link>
        ))}
      </div>
    </DocsContent>
  );
}
