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

export function SkillsReferenceContactsContent() {
  return (
    <>
      <DocsContent title="Contacts" breadcrumb="Docs / Skills Reference / Contacts">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Manages your contacts, communication channels, access control, and invite links. Tracks
            who can reach your assistant and through which channels.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            None for basic contact management. Google Contacts integration available via OAuth.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Google OAuth (optional, for importing Google Contacts)</li>
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
                    &ldquo;Add Alice as a contact&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Creates a new contact entry
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What&apos;s Jake&apos;s email?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Searches contact details
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Send Alice an invite to connect on Telegram&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Generates a channel-specific invite link
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Import my Google Contacts&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Syncs contacts from Google
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Make Alice a trusted contact&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Grants access control privileges
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Block messages from this number&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Updates channel status
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
              Contacts can have multiple channels (Telegram, Slack, phone)
            </li>
            <li>Channel statuses: active, revoked, blocked</li>
            <li>
              Trusted contacts can interact with your assistant on your behalf
            </li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Access management.</strong> Contacts are how you manage who can reach your
              assistant through external channels.
            </li>
            <li>
              <strong>Trusted contacts.</strong> Making someone a &ldquo;trusted contact&rdquo;
              gives them limited access to your assistant &mdash; they can chat but can&apos;t
              access your memories or sensitive tools without guardian approval.
            </li>
            <li>
              <strong>Invite links.</strong> Invite links are channel-specific and can be revoked.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
