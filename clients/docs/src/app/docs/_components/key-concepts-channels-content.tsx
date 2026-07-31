"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "web", label: "Web", level: 2 },
  { id: "desktop-app", label: "Desktop App", level: 2 },
  { id: "ios", label: "iOS", level: 2 },
  { id: "cli", label: "CLI", level: 2 },
  { id: "telegram", label: "Telegram", level: 2 },
  { id: "slack", label: "Slack", level: 2 },
  { id: "email", label: "Email", level: 2 },
  { id: "phone-calls", label: "Phone Calls", level: 2 },
  {
    id: "channels-vs-interfaces",
    label: "Channels vs. interfaces",
    level: 2,
  },
  { id: "what-works-where", label: "What works where", level: 2 },
  {
    id: "same-assistant-everywhere",
    label: "Same assistant, everywhere",
    level: 2,
  },
  { id: "the-guardian", label: "The guardian", level: 2 },
  { id: "setting-up-channels", label: "Setting up channels", level: 2 },
];

export function KeyConceptsChannelsContent() {
  return (
    <>
      <DocsContent
        title="Channels"
        breadcrumb="Docs / Key Concepts / Channels"
      >
        <p className="mb-8 text-zinc-600">
          A channel is how you talk to your assistant. Your assistant is the
          same everywhere — same personality, same memories, same skills. The
          only thing that changes is where you&apos;re talking to it and what
          the channel can do.
        </p>

        {/* ── Web ──────────────────────────────────────────────────── */}
        <section id="web">
          <SectionHeading id="web" level={2}>
            Web
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The browser experience. Sign in at your Vellum Cloud URL and
            you&apos;re talking to your assistant in seconds, no install
            required. Works on any modern browser, any device.
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Chat</strong> &mdash; full conversational UI with
              cards, tables, forms, and other rich surfaces
            </li>
            <li>
              <strong>About your assistant</strong> &mdash; browse identity, skills,
              workspace files, contacts, and memories
            </li>
            <li>
              <strong>Document editor</strong> &mdash; long-form writing
              with your assistant as collaborator
            </li>
            <li>
              <strong>App viewer</strong> &mdash; interactive apps your
              assistant builds render right in the page
            </li>
            <li>
              <strong>Voice input</strong> &mdash; press to talk using
              your browser&apos;s microphone
            </li>
            <li>
              <strong>Approvals</strong> &mdash; native in-page permission
              prompts, same as the desktop app
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Web is cloud-only by design &mdash; the assistant runs in your
            Vellum Cloud account, with the workspace and sandbox living
            there. The browser doesn&apos;t have access to your local
            machine, so host file access, shell commands, computer use, and
            screen watch aren&apos;t available here. For those, use the
            desktop app.
          </p>
        </section>

        {/* ── Desktop App ──────────────────────────────────────────── */}
        <section id="desktop-app" className="mt-12">
          <SectionHeading id="desktop-app" level={2}>
            Desktop App
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The flagship experience. A native macOS menu bar app with full
            capabilities:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Chat</strong> — type messages, see responses, interact
              with cards, tables, and other UI surfaces
            </li>
            <li>
              <strong>Computer use</strong> — your assistant can see your screen
              and control your Mac directly
            </li>
            <li>
              <strong>Voice input</strong> — hold your activation key and speak,
              or enable wake word detection
            </li>
            <li>
              <strong>Document editor</strong> — long-form writing with your
              assistant as collaborator
            </li>
            <li>
              <strong>App viewer</strong> — interactive apps your assistant
              builds render right in the window
            </li>
            <li>
              <strong>Screen watch</strong> — your assistant can observe what
              you&apos;re doing and offer context-aware help
            </li>
            <li>
              <strong>Host file &amp; shell access</strong> — your assistant can
              read files and run commands on your machine
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Every tool, every skill, every feature is available here. If a
            capability exists, the desktop app supports it.
          </p>
        </section>

        {/* ── CLI ──────────────────────────────────────────────────── */}
        <section id="ios" className="mt-12">
          <SectionHeading id="ios" level={2}>
            iOS
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The pocket experience. The Vellum Assistant app on iPhone
            and iPad signs into your Vellum Cloud account and gives you
            the same assistant you talk to on the web and desktop, with
            the same memory and the same conversations carried across.
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Chat anywhere</strong> &mdash; full conversational
              UI on the go
            </li>
            <li>
              <strong>Conversation continuity</strong> &mdash; pick up
              where you left off on Mac or web; history is shared
            </li>
            <li>
              <strong>Push notifications</strong> &mdash; your assistant
              can reach you when something needs your attention
            </li>
            <li>
              <strong>Approvals</strong> &mdash; native iOS prompts when
              a tool call needs your go-ahead
            </li>
          </ul>
          <p className="mb-4 text-zinc-600">
            Like Web, iOS is cloud-only by design. The assistant runs in
            your Vellum Cloud account, so host file access, shell
            commands, computer use, and screen watch live with the
            desktop app.
          </p>
          <p className="mb-0 text-zinc-600">
            Available on the{" "}
            <a href="https://apps.apple.com/us/app/vellum-assistant/id6759934423">
              App Store
            </a>{" "}
            for iPhone and iPad.
          </p>
        </section>

        <section id="cli" className="mt-12">
          <SectionHeading id="cli" level={2}>
            CLI
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A command-line interface for interacting with your assistant from
            the terminal. Uses the same SSE streaming connection as the desktop
            app — meaning it&apos;s a full interactive interface, not just a
            dumb pipe.
          </p>
          <p className="mb-0 text-zinc-600">
            Permission approval prompts work natively in the CLI, and all
            sandbox-based skills are available. Useful for scripting,
            automation, or if you prefer working in a terminal.
          </p>
        </section>

        {/* ── Telegram ─────────────────────────────────────────────── */}
        <section id="telegram" className="mt-12">
          <SectionHeading id="telegram" level={2}>
            Telegram
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Connect a Telegram bot to your assistant and message it from
            anywhere. Setup takes a few minutes:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>Create a bot via BotFather</li>
            <li>Give your assistant the bot token</li>
            <li>Your assistant registers the webhook automatically</li>
          </ol>
          <p className="mb-4 text-zinc-600">
            From there, you can chat with your assistant in Telegram like any
            other contact. It supports text, images, documents, and interactive
            inline buttons for approvals. When your assistant needs permission
            to do something, it sends an inline keyboard you can tap.
          </p>
          <p className="mb-0 text-zinc-600">
            Telegram is also one of the channels your assistant can use to
            reach you — notifications, follow-ups, and alerts can all land in
            your Telegram chat.
          </p>
        </section>

        {/* ── Slack ────────────────────────────────────────────────── */}
        <section id="slack" className="mt-12">
          <SectionHeading id="slack" level={2}>
            Slack
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Connect your assistant to Slack workspaces via Socket Mode. It can:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Respond to @mentions in channels</li>
            <li>Hold threaded conversations</li>
            <li>Send rich messages with Block Kit formatting</li>
            <li>Handle approvals via interactive buttons</li>
            <li>
              Send ephemeral messages (visible only to you) for sensitive
              prompts
            </li>
          </ul>
          <p className="mb-4 text-zinc-600">
            Slack has a unique feature:{" "}
            <strong>per-channel permission profiles</strong>. You can configure
            which tool categories are allowed in which Slack channels, block
            specific tools, and set trust level overrides. For example, an
            engineering channel might allow coding and terminal tools, while a
            general channel restricts them to{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              restricted
            </code>{" "}
            trust.
          </p>
          <p className="mb-0 text-zinc-600">
            Notifications are delivered to Slack, and invite code redemption is
            supported for onboarding new contacts via Slack.
          </p>
        </section>

        {/* ── Email ────────────────────────────────────────────────── */}
        <section id="email" className="mt-12">
          <SectionHeading id="email" level={2}>
            Email
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Email works in two distinct modes: managing{" "}
            <strong>your email</strong> and giving the assistant{" "}
            <strong>its own inbox</strong>.
          </p>

          <h4 className="mb-2 mt-6 text-sm font-semibold text-zinc-800">
            Your email (Gmail)
          </h4>
          <p className="mb-4 text-zinc-600">
            Connect your Gmail account via Google OAuth and your assistant
            becomes a full email manager. This is what happens when you say
            &ldquo;check my email&rdquo; or &ldquo;clean up my inbox&rdquo; —
            it defaults to your Gmail, not the assistant&apos;s own address.
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Read, search, and triage your inbox</li>
            <li>Draft and send emails on your behalf (draft-first workflow — nothing sends without your approval)</li>
            <li>Archive, label, trash, and organize messages</li>
            <li>Unsubscribe from mailing lists</li>
            <li>Bulk declutter with sender digest scanning</li>
            <li>Create inbox filters for automation</li>
            <li>Manage attachments, forwarding, and follow-up tracking</li>
            <li>Vacation auto-responder</li>
          </ul>
          <p className="mb-4 text-zinc-600">
            Gmail is also a platform in the unified messaging system — your
            assistant can read, search, and send across Gmail, Telegram, and
            other connected platforms through a single interface.
          </p>

          <h4 className="mb-2 mt-6 text-sm font-semibold text-zinc-800">
            Assistant&apos;s own email (AgentMail)
          </h4>
          <p className="mb-4 text-zinc-600">
            Your assistant can also have its own email address. This is behind
            a feature flag (
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              email-channel
            </code>
            ) and uses a provider-agnostic architecture — currently backed by
            AgentMail.
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Receive and process inbound emails to the assistant&apos;s address</li>
            <li>Draft, approve, and send outbound emails as the assistant</li>
            <li>Thread-aware conversations</li>
            <li>Custom domain setup with DNS verification</li>
            <li>Invite code redemption for onboarding contacts</li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Outbound notification delivery is not currently enabled on the
            assistant&apos;s email. Conversations use the{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              continue_existing_conversation
            </code>{" "}
            strategy, meaning replies stay in the same thread.
          </p>
        </section>

        {/* ── Phone Calls ──────────────────────────────────────────── */}
        <section id="phone-calls" className="mt-12">
          <SectionHeading id="phone-calls" level={2}>
            Phone Calls
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your assistant can make and receive phone calls via Twilio.
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Inbound calls</strong> — callers reach your
              assistant&apos;s phone number, and it answers with real-time voice
              conversation powered by ElevenLabs text-to-speech
            </li>
            <li>
              <strong>Outbound calls</strong> — your assistant can call people
              on your behalf (for example, during guardian verification)
            </li>
            <li>
              <strong>Transcripts</strong> — call recordings are transcribed and
              stored as conversation history
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Phone is the most constrained channel. Notifications cannot be
            delivered to it, invite code redemption is not supported, and
            conversations are{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              not_deliverable
            </code>{" "}
            — meaning the assistant can&apos;t initiate a message to a phone
            number outside of an active call. Setup requires a Twilio account
            and a provisioned phone number.
          </p>
        </section>

        {/* ── Channels vs. Interfaces ──────────────────────────────── */}
        <section id="channels-vs-interfaces" className="mt-12">
          <SectionHeading id="channels-vs-interfaces" level={2}>
            Channels vs. interfaces
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Internally, the system distinguishes between{" "}
            <strong>channels</strong> and <strong>interfaces</strong>.
          </p>
          <p className="mb-4 text-zinc-600">
            <strong>Channels</strong> are the six communication transports:{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              vellum
            </code>
            ,{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              telegram
            </code>
            ,{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              slack
            </code>
            ,{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              email
            </code>
            , and{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">
              phone
            </code>
            . Every message has a channel.
          </p>
          <p className="mb-4 text-zinc-600">
            <strong>Interfaces</strong> are more specific &mdash; they
            include the channels plus the specific clients used to send the
            message. The <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">vellum</code>{" "}
            channel has four interfaces:{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">macos</code>{" "}
            (the desktop app),{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">web</code>{" "}
            (the browser),{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">ios</code>{" "}
            (the iPhone and iPad app), and{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">cli</code>{" "}
            (the terminal). A message on the{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-sm">vellum</code>{" "}
            channel might come from any of these &mdash; the interface tells
            the system which one.
          </p>
          <p className="mb-0 text-zinc-600">
            The distinction matters for capabilities. The macOS, web, iOS,
            and CLI interfaces are <strong>interactive</strong> &mdash; they
            have an SSE client capable of displaying native permission prompts.
            Channel interfaces (Telegram, Slack, etc.) route approvals
            through the guardian system instead.
          </p>
        </section>

        {/* ── What works where ─────────────────────────────────────── */}
        <section id="what-works-where" className="mt-12">
          <SectionHeading id="what-works-where" level={2}>
            What works where
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Not every channel can do everything. Here&apos;s what to expect:
          </p>
          <div className="mb-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Capability
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Web
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Desktop
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    iOS
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    CLI
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Telegram
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Slack
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Email
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Phone
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2">
                    <strong>Chat</strong>
                  </td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Voice</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Computer use</strong>
                  </td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">—</td>
                  <td className="px-3 py-2">—</td>
                  <td className="px-3 py-2">—</td>
                  <td className="px-3 py-2">—</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Host file/shell access</strong>
                  </td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">—</td>
                  <td className="px-3 py-2">—</td>
                  <td className="px-3 py-2">—</td>
                  <td className="px-3 py-2">—</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Screen watch</strong>
                  </td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">—</td>
                  <td className="px-3 py-2">—</td>
                  <td className="px-3 py-2">—</td>
                  <td className="px-3 py-2">—</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Voice input</strong>
                  </td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">—</td>
                  <td className="px-3 py-2">—</td>
                  <td className="px-3 py-2">—</td>
                  <td className="px-3 py-2">Yes</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Approvals</strong>
                  </td>
                  <td className="px-3 py-2">Native prompt</td>
                  <td className="px-3 py-2">Native prompt</td>
                  <td className="px-3 py-2">Native prompt</td>
                  <td className="px-3 py-2">Native prompt</td>
                  <td className="px-3 py-2">Inline buttons</td>
                  <td className="px-3 py-2">Interactive buttons</td>
                  <td className="px-3 py-2">Plain text</td>
                  <td className="px-3 py-2">—</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Rich content</strong>
                  </td>
                  <td className="px-3 py-2">Full UI</td>
                  <td className="px-3 py-2">Full UI</td>
                  <td className="px-3 py-2">Mobile UI</td>
                  <td className="px-3 py-2">Text</td>
                  <td className="px-3 py-2">Markdown + media</td>
                  <td className="px-3 py-2">Block Kit</td>
                  <td className="px-3 py-2">HTML</td>
                  <td className="px-3 py-2">Voice only</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Notifications</strong>
                  </td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">&mdash;</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Invite codes</strong>
                  </td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">&mdash;</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">Yes</td>
                  <td className="px-3 py-2">—</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Skills</strong>
                  </td>
                  <td className="px-3 py-2">All (cloud)</td>
                  <td className="px-3 py-2">All</td>
                  <td className="px-3 py-2">All (cloud)</td>
                  <td className="px-3 py-2">All</td>
                  <td className="px-3 py-2">All</td>
                  <td className="px-3 py-2">
                    All (with channel permissions)
                  </td>
                  <td className="px-3 py-2">All</td>
                  <td className="px-3 py-2">Limited</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-0 text-zinc-600">
            Your assistant adapts its output to what the channel supports. If
            it would normally show you an interactive card, it&apos;ll send
            plain text on Telegram or speak it on a phone call instead.
          </p>
        </section>

        {/* ── Same assistant, everywhere ────────────────────────────── */}
        <section id="same-assistant-everywhere" className="mt-12">
          <SectionHeading id="same-assistant-everywhere" level={2}>
            Same assistant, everywhere
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your assistant&apos;s identity, personality, and memory are
            channel-independent. A conversation that starts on your desktop can
            be followed up on Telegram. A fact you share over a phone call is
            remembered in Slack.
          </p>
          <p className="mb-0 text-zinc-600">
            What ties it together is the guardian system &mdash; covered in
            the next section.
          </p>
        </section>

        {/* ── The guardian ─────────────────────────────────────────── */}
        <section id="the-guardian" className="mt-12">
          <SectionHeading id="the-guardian" level={2}>
            The guardian
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The <strong>guardian</strong> is you &mdash; the primary owner of
            the assistant. Guardians have full access to memories, workspace
            files, tools, and credentials, and are the only ones who can
            grant approval for sensitive actions. Channels are how the
            guardian system stretches that trust across the places you
            actually live.
          </p>
          <p className="mb-3 text-zinc-600">
            Three things the guardian system does on every channel:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Verifies who&apos;s talking.</strong> The first time
              you message your assistant on a new channel, you go through a
              short challenge-response flow that links that channel identity
              (your Telegram chat ID, Slack handle, phone number, email
              address) to your guardian account. Once verified, the
              assistant trusts that messages from there are coming from you.
            </li>
            <li>
              <strong>Routes approvals.</strong> When the assistant needs
              permission to do something sensitive, it asks the guardian. On
              interactive channels (web, desktop, CLI) the prompt appears
              inline. On other channels (Telegram, Slack, email), the
              approval is sent through the channel itself &mdash; you reply
              there to allow or deny. Approvals routed through a channel are
              always downgraded to one-time grants.
            </li>
            <li>
              <strong>Gates memory extraction.</strong> Long-term memories
              are only extracted from messages by trusted guardians.
              Messages from contacts or unverified parties are indexed for
              search inside that conversation but can&apos;t reshape what
              your assistant knows about you.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Multiple channels can point to the same guardian. Once your
            Telegram, Slack, phone, and email are all linked to your
            account, your assistant treats them as one person across
            conversations. For the full model and how trust rules work, see{" "}
            <a href="/docs/trust-security/the-permissions-model">
              The permissions model
            </a>
            .
          </p>
        </section>

        {/* ── Setting up channels ──────────────────────────────────── */}
        <section id="setting-up-channels" className="mt-12">
          <SectionHeading id="setting-up-channels" level={2}>
            Setting up channels
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Web and desktop don&apos;t need setup beyond signing in to your
            Vellum Cloud account (or installing the app, for desktop). Other
            channels are configured through your assistant. You can say
            things like:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>&ldquo;Set up Telegram&rdquo;</li>
            <li>&ldquo;Connect to Slack&rdquo;</li>
            <li>&ldquo;Set up voice&rdquo;</li>
            <li>&ldquo;Provision a phone number&rdquo;</li>
          </ul>
          <p className="mb-4 text-zinc-600">
            Your assistant walks you through the setup conversationally —
            providing API keys, authorizing OAuth, configuring webhooks —
            rather than through a separate settings panel. Each channel has its
            own setup skill that handles the end-to-end flow.
          </p>
          <p className="mb-0 text-zinc-600">
            Some channels require external service accounts (Twilio for phone,
            BotFather for Telegram). Your
            assistant will guide you through creating those when needed.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
