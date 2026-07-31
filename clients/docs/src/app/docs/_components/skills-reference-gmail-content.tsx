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

export function SkillsReferenceGmailContent() {
  return (
    <>
      <DocsContent title="Gmail" breadcrumb="Docs / Skills Reference / Gmail">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Full Gmail management: archive, label, draft, send, unsubscribe, manage filters,
            track follow-ups, and handle attachments. Your assistant&apos;s direct line to your
            inbox.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            OAuth2 connection to Google. Say &ldquo;Connect my Gmail.&rdquo; One-time setup.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>OAuth2 with Google (scoped to Gmail only)</li>
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
                    &ldquo;Archive everything from newsletters&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Bulk archives matching emails
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Unsubscribe me from marketing emails&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Finds and unsubscribes from mailing lists
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Draft a reply to Alice&apos;s last email&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Creates a draft response
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What emails need my attention?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Scans inbox for important items
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Set up a filter for Jira notifications&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Creates a Gmail filter rule
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Turn on my vacation responder&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Configures auto-reply
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Who&apos;s been emailing me the most?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Runs a sender digest analysis
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
            <li>Connected via OAuth2</li>
            <li>Supports labels, filters, and vacation responder</li>
            <li>Sending requires explicit approval</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Sending is gated.</strong> Drafts are created first, you approve before
              sending.
            </li>
            <li>
              <strong>Attachments work both ways.</strong> You can download attachments from emails
              and attach files to outgoing messages.
            </li>
            <li>
              <strong>Cold outreach detection.</strong> The skill can scan for cold outreach and bulk
              sender patterns.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
