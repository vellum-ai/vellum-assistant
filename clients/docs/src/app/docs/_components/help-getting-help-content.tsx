"use client";

import Image from "next/image";
import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "ask-your-assistant-first", label: "Ask your assistant first", level: 2 },
  { id: "share-feedback", label: "Share feedback", level: 2 },
  { id: "community", label: "Community", level: 2 },
  { id: "github-issues", label: "GitHub Issues", level: 2 },
  { id: "email-support", label: "Email support", level: 2 },
  { id: "what-to-include-when-asking-for-help", label: "What to include when asking for help", level: 2 },
  { id: "check-for-updates", label: "Check for updates", level: 2 },
];

export function HelpGettingHelpContent() {
  return (
    <>
      <DocsContent title="Getting Help" breadcrumb="Docs / Help / Getting Help">
        <p className="mb-8 text-zinc-600">
          The docs didn&apos;t solve it. Your assistant is confused. Something is genuinely broken.
          Here&apos;s where to go next.
        </p>

        <section id="ask-your-assistant-first">
          <SectionHeading id="ask-your-assistant-first" level={2}>
            Ask your assistant first
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            This sounds obvious, but it&apos;s worth saying: your assistant can troubleshoot itself.
          </p>
          <blockquote className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Why isn&apos;t my calendar working?&rdquo;
          </blockquote>
          <blockquote className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Something went wrong with that last action. What happened?&rdquo;
          </blockquote>
          <blockquote className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Help me debug this skill.&rdquo;
          </blockquote>
          <p className="mb-0 text-zinc-600">
            Your assistant has access to its own logs, its own configuration, and its own error
            messages. It can often diagnose and fix problems faster than any support channel.
          </p>
        </section>

        <section id="share-feedback" className="mt-12">
          <SectionHeading id="share-feedback" level={2}>
            Share feedback
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            <strong>Share feedback</strong> sends your recent logs to the Vellum team along with a
            short note from you. It&apos;s the single most useful thing you can do when something
            goes wrong — without logs, we&apos;re guessing.
          </p>
          <p className="mb-4 text-zinc-600">
            On the <strong>desktop app</strong>, open the <em>Help</em> menu in the macOS menu bar
            and pick <em>Share Feedback</em>.
          </p>
          <div className="mb-6 overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <Image
              src="/docs/docs-share-feedback-macos.webp"
              alt="The Vellum desktop app's Help menu opened from the macOS menu bar, showing Documentation, Discord Community, and Share Feedback items with Share Feedback highlighted."
              width={962}
              height={360}
              unoptimized
              className="w-full"
            />
          </div>
          <p className="mb-4 text-zinc-600">
            You can also reach the same form from the sidebar drawer menu, the conversation
            right-click menu, or the <em>Share Feedback</em> button that appears in Settings after
            an upgrade error.
          </p>
          <p className="mb-4 text-zinc-600">
            On the <strong>web app</strong>, open the user menu in the top-right corner and pick{" "}
            <em>Share Feedback</em>.
          </p>
          <div className="mb-6 overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <Image
              src="/docs/docs-share-feedback-web.webp"
              alt="The Vellum web app's user menu opened in the top-right corner, showing Theme, credits, Earn credits, Settings, Usage, Share Feedback (highlighted), Admin, and Log Out items."
              width={622}
              height={774}
              unoptimized
              className="mx-auto"
            />
          </div>
          <p className="mb-0 text-zinc-600">
            A short modal will appear — describe what happened in a sentence or two, then submit.
            The form bundles your last few minutes of logs so the team can see exactly what went
            wrong on your end.
          </p>
        </section>

        <section id="community" className="mt-12">
          <SectionHeading id="community" level={2}>
            Community
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Check out our{" "}
            <Link href="https://www.vellum.ai/community" className="font-semibold text-emerald-700 underline hover:text-emerald-800">
              Community page
            </Link>{" "}
            for links to Discord, forums, and other channels.
          </p>
          <p className="mb-0 mt-4 text-zinc-600">
            When community channels are available, they&apos;ll be the fastest way to get help from
            other users who&apos;ve probably hit the same issue. We&apos;ll also have team members active
            in the community.
          </p>
        </section>



        <section id="email-support" className="mt-12">
          <SectionHeading id="email-support" level={2}>
            Email support
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            <a href="mailto:support@vellum.ai" className="font-semibold text-emerald-700 underline hover:text-emerald-800">
              support@vellum.ai
            </a>
          </p>
          <p className="mb-0 text-zinc-600">
            For issues that don&apos;t fit in a public channel, or if you need direct help.
            We&apos;ll do our best to respond quickly.
          </p>
        </section>

        <section id="what-to-include-when-asking-for-help" className="mt-12">
          <SectionHeading id="what-to-include-when-asking-for-help" level={2}>
            What to include when asking for help
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            No matter where you ask, these details help us (or the community) help you faster:
          </p>
          <div className="mb-0 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Detail
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Why it helps
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2"><strong>What you were doing</strong></td>
                  <td className="px-3 py-2">Context for the problem</td>
                </tr>
                <tr>
                  <td className="px-3 py-2"><strong>What went wrong</strong></td>
                  <td className="px-3 py-2">The error, the unexpected behavior, the missing result</td>
                </tr>
                <tr>
                  <td className="px-3 py-2"><strong>Error messages</strong></td>
                  <td className="px-3 py-2">The exact text, not a paraphrase</td>
                </tr>
                <tr>
                  <td className="px-3 py-2"><strong>macOS version</strong></td>
                  <td className="px-3 py-2">Compatibility issues are real</td>
                </tr>
                <tr>
                  <td className="px-3 py-2"><strong>Vellum version</strong></td>
                  <td className="px-3 py-2">Bugs get fixed in updates</td>
                </tr>
                <tr>
                  <td className="px-3 py-2"><strong>Skills involved</strong></td>
                  <td className="px-3 py-2">Narrows down the problem area</td>
                </tr>
                <tr>
                  <td className="px-3 py-2"><strong>Steps to reproduce</strong></td>
                  <td className="px-3 py-2">Lets us recreate the issue on our end</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="check-for-updates" className="mt-12">
          <SectionHeading id="check-for-updates" level={2}>
            Check for updates
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Sometimes the fix already exists in a newer version:
          </p>
          <blockquote className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Check for updates.&rdquo;
          </blockquote>
          <blockquote className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Update Vellum.&rdquo;
          </blockquote>
          <p className="mb-0 text-zinc-600">
            Your assistant can check for and install updates. Many issues are resolved by simply
            being on the latest version.
          </p>
        </section>

        <hr className="mt-10 border-zinc-200" />
        <p className="mb-0 mt-8 text-zinc-600">
          <em>
            That&apos;s everything. If you&apos;ve read this far, you&apos;re either very thorough or very
            stuck. Either way, we appreciate you. Now go talk to your assistant. It misses you.
          </em>{" "}
          😏
        </p>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
