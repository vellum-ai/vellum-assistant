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

export function SkillsReferenceFollowupsContent() {
  return (
    <>
      <DocsContent title="Followups" breadcrumb="Docs / Skills Reference / Followups">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Tracks messages you&apos;ve sent that are awaiting responses across all communication
            channels. Knows when you&apos;re waiting on someone and can nudge them.
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
            <li>Requires connected messaging channels (Gmail, Slack, etc.) for tracking</li>
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
                    &ldquo;Track my email to Alice &mdash; I need a response by Friday&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Creates a follow-up tracker
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What messages am I still waiting on?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Lists pending follow-ups
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Mark Alice&apos;s response as received&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Resolves a follow-up
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Nudge Jake about the proposal I sent last week&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Sends a follow-up message
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
            <li>Lifecycle states: pending, overdue, nudged, resolved</li>
            <li>Set expected response deadlines</li>
            <li>Automatic tracking of response status</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Cross-channel tracking.</strong> Works across channels &mdash; track an email,
              a Slack DM, or a phone call.
            </li>
            <li>
              <strong>Automatic nudges.</strong> The assistant can schedule automatic nudges if
              someone hasn&apos;t responded by the deadline.
            </li>
            <li>
              <strong>Grace periods.</strong> Contact-based grace periods prevent over-nudging.
            </li>
            <li>
              <strong>Auto-resolve.</strong> Follow-ups resolve automatically when the person
              replies.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
