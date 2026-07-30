"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "short-version", label: "The short version", level: 2 },
  {
    id: "how-is-this-different-from-chatgpt-claude-etc",
    label: "How is this different from ChatGPT / Claude / etc.?",
    level: 2,
  },
  { id: "what-can-it-do", label: "What can it do?", level: 2 },
  { id: "where-does-it-run", label: "Where does it run?", level: 2 },
  { id: "how-does-it-work-the-30-second-version", label: "How does it work? (The 30-second version)", level: 2 },
  { id: "is-it-safe", label: "Is it safe?", level: 2 },
];

export function WhatIsVellumContent() {
  return (
    <>
      <DocsContent title="What is Vellum?" breadcrumb="Docs / Getting Started / What is Vellum?">
        <section id="short-version">
          <SectionHeading id="short-version" level={2}>
            The short version
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Vellum is a personal AI assistant that lives in the secure Vellum
            Cloud, available wherever you are. It can have its own identity,
            its own email, its own accounts, its own logins. It can read your
            files, manage your calendar, order you food, build you an app,
            control your computer, take calls on your behalf, and remember
            that you take your coffee black.
          </p>
          <p className="mb-6 text-zinc-600">
            It&apos;s not a chatbot. It&apos;s not an autocomplete engine. It&apos;s a
            separate entity that works for you, learns about you, and takes real
            actions in the real world.
          </p>
        </section>

        <section id="how-is-this-different-from-chatgpt-claude-etc" className="mt-12">
          <SectionHeading id="how-is-this-different-from-chatgpt-claude-etc" level={2}>
            How is this different from ChatGPT / Claude / etc.?
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Those are conversation tools. You type, they respond, you copy-paste the
            answer somewhere useful. The conversation ends and everything resets.
          </p>
          <p className="mb-6 text-zinc-600">
            Vellum is different in a few important ways:
          </p>
          <p className="mb-3 text-zinc-600">
            <strong>It has tools, not just words.</strong> Your assistant can browse
            the web, read your files, run code, send emails, manage your calendar,
            and interact with dozens of services. It can also see your screen and
            control your Mac directly: clicking, typing, and navigating apps on
            your behalf through macOS accessibility APIs. Sensitive actions always
            require your approval first. It doesn&apos;t describe what you{" "}
            <em>could</em> do. It does it.
          </p>
          <p className="mb-3 text-zinc-600">
            <strong>It remembers you.</strong> Not just within a single conversation.
            Across days, weeks, months. Your preferences, your projects, your quirks.
            It builds a picture of who you are and uses that to help you better over
            time.
          </p>
          <p className="mb-3 text-zinc-600">
            <strong>It has its own identity.</strong> Your assistant isn&apos;t
            borrowing yours. It can have its own email, its own GitHub account,
            its own Slack handle. When it sends an email on your behalf, the
            recipient knows they&apos;re talking to your assistant, not to you.
            Clear boundaries, no confusion.
          </p>
          <p className="mb-3 text-zinc-600">
            <strong>Your data stays yours.</strong> Your workspace, your memories,
            your configuration... all live in your private Vellum Cloud account,
            encrypted and isolated, or on your own machine if you self-host. No
            shared database, no opaque storage, no data you can&apos;t access.
            Plain-text, exportable, deletable, yours.
          </p>
          <p className="mb-0 text-zinc-600">
            <strong>It&apos;s personal.</strong> Not a team tool. Not a shared
            resource. Not a Slack bot everyone in your company uses. It&apos;s{" "}
            <em>your</em> assistant, personalized to <em>you</em>, and nobody else can
            access it.
          </p>
        </section>

        <section id="what-can-it-do" className="mt-12">
          <SectionHeading id="what-can-it-do" level={2}>
            What can it do?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            A non-exhaustive list of things your assistant can handle, organized by category:
          </p>

          <h3 className="mb-3 text-base font-semibold text-zinc-800">💬 Communication</h3>
          <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-600">
            <li><strong>Gmail</strong>: Manage your inbox, draft replies, archive, label, and unsubscribe</li>
            <li><strong>Email (Agent Mail)</strong>: Give your assistant its own email address to send and receive mail</li>
            <li><strong>Messaging</strong>: Read, search, and send messages across multiple platforms</li>
            <li><strong>Phone Calls</strong>: Make and receive phone calls via Twilio</li>
            <li><strong>Slack</strong>: Scan channels, summarize threads, send and manage messages</li>
            <li><strong>Contacts</strong>: Manage contacts, communication channels, and access control</li>
            <li><strong>Notifications</strong>: Send notifications through the unified notification router</li>
          </ul>

          <h3 className="mb-3 text-base font-semibold text-zinc-800">📅 Productivity</h3>
          <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-600">
            <li><strong>Google Calendar</strong>: Check schedules, create events, and coordinate availability</li>
            <li><strong>Tasks</strong>: Reusable task templates and a prioritized work queue</li>
            <li><strong>Schedule</strong>: Recurring and one-shot scheduling with cron, RRULE, or single fire-at time</li>
            <li><strong>Followups</strong>: Track sent messages awaiting responses across channels</li>
            <li><strong>Playbooks</strong>: Trigger-action automation rules for handling incoming messages</li>
            <li><strong>Document</strong>: Write and edit long-form content like blog posts, articles, and reports</li>
            <li><strong>Start the Day</strong>: Get a personalized daily briefing with weather, calendar, news, and tasks</li>
          </ul>

          <h3 className="mb-3 text-base font-semibold text-zinc-800">🖥️ Automation &amp; Control</h3>
          <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-600">
            <li><strong>Computer Use</strong>: Control your Mac directly (click, type, and navigate apps via macOS accessibility APIs)</li>
            <li><strong>Browser</strong>: Navigate and interact with web pages using a headless browser</li>
            <li><strong>Screen Watch</strong>: Observe the screen at regular intervals with OCR</li>
            <li><strong>Watcher</strong>: Poll and monitor external sources for changes</li>
            <li><strong>Subagent</strong>: Spawn autonomous background agents for parallel work</li>
          </ul>

          <h3 className="mb-3 text-base font-semibold text-zinc-800">🛠️ Development</h3>
          <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-600">
            <li><strong>App Builder</strong>: Build interactive apps, dashboards, tools, and data visualizations</li>
            <li><strong>Frontend Design</strong>: Create distinctive, production-grade frontend interfaces with high design quality</li>
            <li><strong>ACP</strong>: Delegate coding tasks to external coding agents via the Agent Client Protocol</li>
          </ul>

          <h3 className="mb-3 text-base font-semibold text-zinc-800">🎨 Media</h3>
          <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-600">
            <li><strong>Image Studio</strong>: Generate and edit images using AI</li>
            <li><strong>Media Processing</strong>: Ingest and process video, audio, and image files</li>
            <li><strong>Transcribe</strong>: Turn audio and video into text with Whisper</li>
          </ul>

          <h3 className="mb-3 text-base font-semibold text-zinc-800">🛍️ Services</h3>
          <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-600">
            <li><strong>Amazon</strong>: Shop on Amazon and Amazon Fresh</li>
            <li><strong>DoorDash</strong>: Order food, groceries, and convenience items</li>
            <li><strong>Weather</strong>: Get current conditions and forecasts for any location</li>
          </ul>

          <h3 className="mb-3 text-base font-semibold text-zinc-800">🧠 Knowledge &amp; Identity</h3>
          <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-600">
            <li><strong>Memory</strong>: Remembers your preferences, projects, and context across conversations</li>
            <li><strong>SOUL.md / IDENTITY.md / USER.md</strong>: Editable files that shape your assistant&apos;s personality and knowledge of you</li>
            <li><strong>Skill Management</strong>: Create and manage custom skills as your needs evolve</li>
          </ul>

          <h3 className="mb-3 text-base font-semibold text-zinc-800">🔗 Integrations</h3>
          <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-600">
            <li><strong>OAuth Integrations</strong>: Connect to third-party services like GitHub, Notion, Linear, Airtable, Spotify, and more</li>
            <li><strong>MCP Servers</strong>: Add Model Context Protocol servers for extended tool access</li>
            <li><strong>ChatGPT Import</strong>: Import conversation history from ChatGPT</li>
            <li><strong>Voice Input</strong>: Hold Fn to talk to your assistant</li>
          </ul>
          <p className="mb-0 text-zinc-600">
            And if it can&apos;t do something? You can teach it. Skills are modular and
            extensible. More on that in{" "}
            <a href="/docs/getting-started/your-first-skill">
              Your First Skill
            </a>
            .
          </p>
        </section>

        <section id="where-does-it-run" className="mt-12">
          <SectionHeading id="where-does-it-run" level={2}>
            Where does it run?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Your assistant lives in Vellum Cloud by default and is reachable from
            anywhere. You can also self-host it on your own Mac if you want full
            control of the runtime.
          </p>
          <div className="mb-6">
            <h3 className="mb-2 text-base font-semibold text-zinc-800">☁️ Vellum Cloud (default)</h3>
            <p className="mb-2 text-zinc-600">
              Sign up and your assistant is provisioned in seconds, hosted in
              Vellum&apos;s secure cloud, always on, always reachable. No install,
              no servers to manage. Your workspace is encrypted and isolated to
              your account.
            </p>
            <ul className="list-disc space-y-1 pl-6 text-zinc-600">
              <li>Use it instantly in your browser at vellum.ai</li>
              <li>Always-on availability, even when your laptop is closed</li>
              <li>Encrypted, isolated workspace tied to your account</li>
              <li>One assistant, reachable across web, desktop, mobile, voice, and chat channels</li>
            </ul>
          </div>
          <div className="mb-6">
            <h3 className="mb-2 text-base font-semibold text-zinc-800">🌐 Web app</h3>
            <p className="mb-2 text-zinc-600">
              Open your assistant in any modern browser. Same conversation,
              memories, and tools as the desktop app, no install required.
            </p>
            <ul className="list-disc space-y-1 pl-6 text-zinc-600">
              <li>Works in Chrome, Safari, Firefox, Arc, and the rest</li>
              <li>Same workspace and identity as your desktop and mobile sessions</li>
              <li>Browser extension available for reading open tabs and acting on the page you&apos;re looking at</li>
            </ul>
          </div>
          <div className="mb-6">
            <h3 className="mb-2 text-base font-semibold text-zinc-800">🖥️ macOS desktop app</h3>
            <p className="mb-2 text-zinc-600">
              Native macOS app with a menu bar presence. Same assistant as the
              web app, plus the ability to control your computer through macOS
              accessibility APIs. Supports macOS 15 (Sequoia) and above.
            </p>
            <ul className="list-disc space-y-1 pl-6 text-zinc-600">
              <li>One-click DMG install</li>
              <li>Desktop automation via macOS accessibility APIs</li>
              <li>Voice input with hold-to-talk (Fn key)</li>
              <li>Connects to your Vellum Cloud assistant, or run a fully self-hosted local workspace</li>
            </ul>
          </div>
          <div className="mb-0">
            <h3 className="mb-2 text-base font-semibold text-zinc-800">📡 Channels</h3>
            <p className="mb-2 text-zinc-600">
              Beyond the apps, you can reach your assistant through external
              channels, so it&apos;s available wherever you are.
            </p>
            <ul className="list-disc space-y-1 pl-6 text-zinc-600">
              <li><strong>Telegram</strong>: Chat with your assistant from any device via a Telegram bot</li>
              <li><strong>Slack</strong>: Message your assistant directly in Slack, useful for work contexts</li>
              <li><strong>Phone</strong>: Call your assistant or have it take calls on your behalf via Twilio</li>
            </ul>
          </div>
        </section>

        <section id="how-does-it-work-the-30-second-version" className="mt-12">
          <SectionHeading id="how-does-it-work-the-30-second-version" level={2}>
            How does it work? (The 30-second version)
          </SectionHeading>
          <ol className="mb-6 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>You talk to it.</strong> In your browser, the desktop app,
              by voice, or through chat channels like Telegram, Slack, and phone.
            </li>
            <li>
              <strong>It thinks.</strong> Your message, along with relevant context
              (your preferences, memories, workspace files), is sent to a cloud AI
              model to generate a response.
            </li>
            <li>
              <strong>It acts.</strong> If the response involves doing something
              (reading a file, sending an email, building an app, or controlling
              your desktop), your assistant uses its tools to make it happen. For
              desktop actions, it sees your screen, plans the steps, and executes
              them automatically. But it won&apos;t go rogue: your assistant
              always asks for permission before taking sensitive actions like sending
              emails, making purchases, or accessing new services. You stay in
              control, and you can configure exactly what requires approval and what
              your assistant can handle on its own.
            </li>
            <li>
              <strong>It learns.</strong> Important facts, preferences, and context
              are saved to your workspace so it gets better over time.
            </li>
          </ol>
          <blockquote className="m-0 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            <strong>Transparency moment:</strong> Whether your assistant lives in
            Vellum Cloud or on your own machine, it <em>thinks</em> by talking to
            an AI model provider (like Anthropic). Your prompts and context are
            sent there to generate responses. This is the trade-off of a smart
            assistant. We&apos;d rather tell you upfront than have you discover it
            in a footnote.
          </blockquote>
        </section>

        <section id="is-it-safe" className="mt-12">
          <SectionHeading id="is-it-safe" level={2}>
            Is it safe?
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Vellum has a built-in trust system. Sensitive actions like sending
            emails, making purchases, or controlling your desktop require your
            explicit approval. You can configure trust rules per channel.
            Credentials are encrypted at rest in Vellum Cloud, or stored in the
            macOS Keychain when you self-host, never in plain text.
          </p>
          <p className="mb-0 text-zinc-600">
            Learn more in{" "}
            <a href="/docs/trust-security">Trust &amp; Security</a>.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
