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

export function SkillsReferenceMessagingContent() {
  return (
    <>
      <DocsContent title="Messaging" breadcrumb="Docs / Skills Reference / Messaging">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Read, search, send, and manage messages across multiple platforms including Slack,
            Gmail, and Telegram from a single conversation with your assistant.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-4 text-zinc-600">Each platform requires its own connection:</p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li><strong>Slack:</strong> OAuth2 authorization. Say &ldquo;Connect my Slack.&rdquo;</li>
            <li><strong>Gmail:</strong> OAuth2 authorization. Say &ldquo;Connect my Gmail.&rdquo;</li>
            <li><strong>Telegram:</strong> Bot token from @BotFather. Say &ldquo;Connect my Telegram.&rdquo;</li>
          </ul>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>OAuth2 tokens stored in the secure credential vault</li>
            <li>No macOS permissions needed</li>
            <li>
              Your assistant sends messages as itself or with your explicit approval, depending
              on the platform
            </li>
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
                    &ldquo;What&apos;s happening in #general on Slack?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Reads recent messages in a Slack channel
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Send a message in #design: mockups are ready&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Posts to a Slack channel
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Summarize my unread Slack messages&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Digest of what you missed
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Search Slack for messages about the API migration&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Finds relevant conversations
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Check my Gmail for anything from Amazon&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Searches your Gmail inbox
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What did Alice say in #engineering yesterday?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Finds specific messages by person and channel
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
            <li>Each platform is connected independently</li>
            <li>Channel access depends on what you&apos;ve authorized</li>
            <li>
Each platform is connected independently via OAuth (Slack, Gmail) or bot token
              (Telegram). Channel access depends on what you&apos;ve authorized for each
              platform
            </li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Multi-platform:</strong> You can ask about messages across platforms in one
              request: &ldquo;Do I have anything important on Slack or Gmail?&rdquo;
            </li>
            <li>
              <strong>Sending messages:</strong> Your assistant will confirm before sending messages
              on your behalf. If you want it to send without asking, set that preference explicitly.
            </li>
            <li>
              <strong>Context awareness:</strong> Your assistant remembers which channels and contacts
              you mention frequently. Over time, &ldquo;check the design channel&rdquo; is enough without
              specifying &ldquo;Slack.&rdquo;
            </li>
            <li>
              <strong>Rate limits:</strong> Some platforms throttle API access. If your assistant
              can&apos;t fetch messages, it may be a temporary rate limit. Wait a few minutes and try again.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
