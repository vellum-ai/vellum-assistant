"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-it-does", label: "What it does", level: 2 },
  { id: "setup-required", label: "Setup required", level: 2 },
  { id: "permissions", label: "Permissions", level: 2 },
  { id: "common-prompts", label: "Common prompts", level: 2 },
  { id: "configuration", label: "Configuration", level: 2 },
  { id: "tips-gotchas", label: "Tips & gotchas", level: 2 },
];

export function SkillsReferenceSlackContent() {
  return (
    <>
      <DocsContent title="Slack" breadcrumb="Docs / Skills Reference / Slack">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Scan channels, summarize threads, manage reactions, and configure Slack integration with
            privacy-aware context sharing.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Slack Bot + App tokens. Say &ldquo;Set up Slack.&rdquo; Creates a Slack app with Socket
            Mode.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Slack Bot Token + App Token</li>
            <li>No macOS permissions needed</li>
          </ul>
        </section>

        <section id="common-prompts" className="mt-12">
          <SectionHeading id="common-prompts" level={2}>
            Common prompts
          </SectionHeading>
          <div className="mb-0 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    You say...
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    What happens
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What happened in #engineering today?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Scans and summarizes channel activity
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Summarize that thread about the API migration&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Thread-level summary with attribution
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;React with &#x1F44D; to Alice&apos;s message&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Adds emoji reaction
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What are the most active channels this week?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Channel activity digest
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Set up channel permissions for #general&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Configures tool access per channel
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="configuration" className="mt-12">
          <SectionHeading id="configuration" level={2}>
            Configuration
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              Per-channel permission profiles let you control which tools are available in which
              Slack channels
            </li>
            <li>Socket Mode means no public webhook URL needed</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Privacy guardrails.</strong> The assistant won&apos;t share Slack context
              outside Slack without explicit instruction.
            </li>
            <li>
              <strong>Thread attribution.</strong> Thread summaries include attribution so you know
              who said what.
            </li>
            <li>
              <strong>Channel permission profiles.</strong> Use them to restrict sensitive tools in
              public channels.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
