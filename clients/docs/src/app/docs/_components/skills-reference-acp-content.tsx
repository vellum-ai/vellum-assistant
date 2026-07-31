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

export function SkillsReferenceACPContent() {
  return (
    <>
      <DocsContent title="ACP" breadcrumb="Docs / Skills Reference / ACP">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Lets your assistant delegate development tasks to external tools such as Claude Code,
            Codex, and Gemini CLI through the Agent Client Protocol.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Requires the external agent to be installed (e.g., Claude Code CLI). Say &ldquo;Set up
            ACP&rdquo; for first-time configuration.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Host shell access for spawning external processes</li>
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
                    &ldquo;Use Claude Code to fix the bug in server.ts&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Delegates to Claude Code agent
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Ask Codex to refactor this module&rdquo;
                  </td>
                  <td className="px-3 py-2">Delegates to Codex</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Check on my coding agent&rdquo;
                  </td>
                  <td className="px-3 py-2">Gets agent status</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Cancel the coding agent&rdquo;
                  </td>
                  <td className="px-3 py-2">Aborts the agent</td>
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
            <li>Supports multiple external development tools (Claude Code, Codex, Gemini CLI)</li>
            <li>Agents run as separate processes with their own context</li>
            <li>Status tracking: pending, running, completed, failed, aborted</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Fully independent.</strong> ACP agents are separate processes with their own
              context window and tools.
            </li>
            <li>
              <strong>Self-contained tasks.</strong> Best for tasks like fixing a bug, refactoring a
              file, or writing tests.
            </li>
            <li>
              <strong>Coordinated results.</strong> Your assistant coordinates with the agent and
              reports back results.
            </li>
            <li>
              <strong>Choose the right agent.</strong> Claude Code for general development, Codex for
              code generation, Gemini CLI for Google ecosystem integration.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
