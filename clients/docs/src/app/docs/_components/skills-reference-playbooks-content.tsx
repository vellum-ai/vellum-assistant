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

export function SkillsReferencePlaybooksContent() {
  return (
    <>
      <DocsContent title="Playbooks" breadcrumb="Docs / Skills Reference / Playbooks">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Trigger-action automation rules for handling incoming messages. Define patterns, and your
            assistant automatically responds or takes action when messages match.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            None. Works with any connected messaging channel.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Inherits permissions from the actions defined in each playbook</li>
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
                    &ldquo;Create a playbook: when someone emails about pricing, draft a reply with
                    our rate card&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Trigger-action rule
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Set up a rule: if I get a Slack DM with &apos;urgent&apos;, notify me on
                    Telegram&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Cross-channel automation
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Show me my active playbooks&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Lists all automation rules
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Disable the pricing email playbook&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Pauses a rule
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
            <li>Trigger patterns (message content matching)</li>
            <li>Action types: auto-respond, draft, notify</li>
            <li>Per-channel scoping</li>
            <li>Categories and priority ordering</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>If this, then that.</strong> Think of playbooks as &ldquo;if this, then
              that&rdquo; rules for your assistant. They run automatically on incoming messages:
              no need to ask each time.
            </li>
            <li>
              <strong>Action modes.</strong> Actions can be &ldquo;auto&rdquo; (execute
              immediately), &ldquo;draft&rdquo; (prepare for your review), or &ldquo;notify&rdquo;
              (alert you).
            </li>
            <li>
              <strong>Priority ordering.</strong> Priority ordering determines which playbook fires
              first when multiple rules match.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
