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

export function SkillsReferenceEmailAgentMailContent() {
  return (
    <>
      <DocsContent
        title="Email (AgentMail)"
        breadcrumb="Docs / Skills Reference / Email (AgentMail)"
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Gives your assistant its own email address so it can send, receive, read, search,
            and manage email independently from your personal inbox.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-4 text-zinc-600">First-time setup needed. Say:</p>
          <blockquote className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Set up your email.&rdquo;
          </blockquote>
          <p className="mb-0 text-zinc-600">
            Your assistant will create its own email address through AgentMail (e.g.,{" "}
            <code>gigi@agentmail.vellum.ai</code>). This is a one-time process. Once set up,
            email works automatically going forward.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>No macOS permissions needed</li>
            <li>Uses your assistant&apos;s own email address, not yours</li>
            <li>Credential stored in the secure vault</li>
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
                  <td className="px-3 py-2">&ldquo;Check my email&rdquo;</td>
                  <td className="px-3 py-2">
                    Reads and summarizes recent messages in your assistant&apos;s inbox
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">&ldquo;Do I have any important emails?&rdquo;</td>
                  <td className="px-3 py-2">
                    Triages inbox by priority and relevance
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Send an email to alex@example.com about the deadline&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Drafts and sends from your assistant&apos;s address
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Draft a reply to Alice&apos;s last email&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Composes a response for your review before sending
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Search my email for anything from Stripe&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Searches inbox by sender, subject, or content
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Summarize the last 10 emails&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Reads and gives you a quick digest
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Unsubscribe from all these marketing emails&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Bulk manages unwanted subscriptions
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
            <li>Email address is assigned during setup</li>
            <li>Your assistant can manage its own inbox organization</li>
            <li>
              <strong>Custom domains:</strong> You can connect your own domain for a
              professional email address. Your assistant handles DNS setup and verification.
            </li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>It&apos;s not your email.</strong> Your assistant sends from its own address.
              Recipients see your assistant&apos;s email, not yours. This is by design.
            </li>
            <li>
              <strong>Forwarding:</strong> If you want your assistant to see emails sent to <em>your</em>{" "}
              address, you&apos;ll need to set up forwarding from your email provider to your
              assistant&apos;s AgentMail address.
            </li>
            <li>
              <strong>Drafts vs. sends:</strong> By default, your assistant may send emails directly.
              If you want to review before sending, tell it: &ldquo;Always show me drafts before sending.&rdquo;
            </li>
            <li>
              <strong>Bulk actions:</strong> Your assistant can triage, archive, and unsubscribe in
              bulk. Use the interactive UI it generates for selecting multiple messages at once.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
