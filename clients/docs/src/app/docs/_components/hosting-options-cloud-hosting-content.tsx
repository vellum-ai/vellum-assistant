"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "overview", label: "Overview", level: 2 },
  { id: "whats-included", label: "What's included", level: 2 },
  { id: "how-it-works", label: "How it works", level: 2 },
  { id: "privacy-and-data", label: "Privacy and data", level: 2 },
  { id: "reaching-your-machine", label: "Reaching your machine", level: 2 },
  { id: "connecting-to-your-assistant", label: "Connecting to your assistant", level: 2 },
  { id: "when-cloud-is-the-right-choice", label: "When Cloud is the right choice", level: 2 },
  { id: "getting-started", label: "Getting started", level: 2 },
];

export function HostingOptionsCloudHostingContent() {
  return (
    <>
      <DocsContent
        title="Cloud hosting"
        breadcrumb="Docs / Hosting options / Cloud hosting"
      >
        <p className="mb-4 text-stone-600 dark:text-stone-400">
          Vellum Cloud is the hosted, always-on home for your assistant.
          You sign in, your assistant runs in its own sandboxed environment
          on Vellum&apos;s infrastructure, and you reach it from web,
          desktop, voice, and chat channels. No servers to manage, no
          ports to open, no laptop you have to keep awake.
        </p>
        <p className="mb-8 text-stone-600 dark:text-stone-400">
          It&apos;s the option we recommend for most users, and it&apos;s
          the one we use to run our own assistants.
        </p>

        <section id="overview">
          <SectionHeading id="overview" level={2}>
            Overview
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400">
            <li>
              <strong>Always on.</strong> Your assistant runs 24/7. Schedules
              fire on time, channels stay connected, and conversations
              survive your laptop being closed.
            </li>
            <li>
              <strong>Sandboxed per account.</strong> Each assistant runs in
              its own isolated container with its own private storage. It
              cannot read other users&apos; data or infrastructure.
            </li>
            <li>
              <strong>Managed model access.</strong> Vellum-managed API keys
              for the default model (Anthropic Claude) are included, so you
              don&apos;t have to bring your own to get started.
            </li>
            <li>
              <strong>Reachable everywhere.</strong> Web, desktop app, voice,
              phone, Telegram, Slack, email. All authenticated to the same
              underlying assistant.
            </li>
            <li>
              <strong>Same workspace, same memory.</strong> The IDENTITY,
              SOUL, USER, NOW files, the PKB, conversations, memories,
              skills, all live in your assistant&apos;s cloud workspace and
              are accessible from any surface you sign in on.
            </li>
          </ul>
        </section>

        <section id="whats-included" className="mt-12">
          <SectionHeading id="whats-included" level={2}>
            What&apos;s included
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            A Vellum Cloud assistant ships with the full feature surface
            out of the box:
          </p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400">
            <li>
              The default Anthropic Claude model on Vellum&apos;s
              credentials. You can{" "}
              <Link
                href={"/docs/key-concepts/the-workspace"}
                className="font-semibold text-emerald-700 underline hover:text-emerald-800"
              >
                bring your own
              </Link>{" "}
              for OpenAI, Gemini, OpenRouter, Fireworks, or a local Ollama
              instance.
            </li>
            <li>
              The full{" "}
              <Link
                href={"/docs/key-concepts/channels"}
                className="font-semibold text-emerald-700 underline hover:text-emerald-800"
              >
                channel
              </Link>{" "}
              system: web, desktop, voice (phone), Telegram, Slack, and
              the optional assistant-owned email address.
            </li>
            <li>
              Long-running infrastructure for{" "}
              <Link
                href={"/docs/key-concepts/scheduling"}
                className="font-semibold text-emerald-700 underline hover:text-emerald-800"
              >
                schedules, watchers, heartbeats, and subagents
              </Link>
              . Schedules fire on time even when your devices are off.
            </li>
            <li>
              An isolated{" "}
              <Link
                href={"/docs/trust-security/privacy-and-data"}
                className="font-semibold text-emerald-700 underline hover:text-emerald-800"
              >
                Credential Execution Service
              </Link>{" "}
              container so OAuth tokens and API keys are never exposed to
              the assistant or the AI model.
            </li>
            <li>
              The{" "}
              <Link
                href={"/docs/key-concepts/memory-and-context"}
                className="font-semibold text-emerald-700 underline hover:text-emerald-800"
              >
                long-term memory store
              </Link>
              , skills, and PKB, all persisted in your private workspace.
            </li>
          </ul>
        </section>

        <section id="how-it-works" className="mt-12">
          <SectionHeading id="how-it-works" level={2}>
            How it works
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            When you create an assistant on Vellum Cloud, three things
            happen:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-stone-600 dark:text-stone-400">
            <li>
              <strong>An assistant container is provisioned.</strong> Your
              assistant runs in its own sandboxed environment with its own
              file system, process tree, and network egress. It cannot
              reach other accounts.
            </li>
            <li>
              <strong>A gateway is wired up.</strong> The gateway is the
              guard rail in front of the assistant. It enforces
              permissions, routes inbound channel messages, mediates
              guardian approvals, and is the only path through which the
              outside world can talk to your assistant.
            </li>
            <li>
              <strong>A separate Credential Execution Service container
              spins up.</strong> CES holds your secrets in private storage
              that the assistant container literally cannot read. The
              assistant only ever sees credentials by alias, never their
              raw values.
            </li>
          </ol>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Same architectural shape as the local install, with Vellum
            running the boxes.
          </p>
        </section>

        <section id="privacy-and-data" className="mt-12">
          <SectionHeading id="privacy-and-data" level={2}>
            Privacy and data
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Your data lives in your private, encrypted Vellum Cloud
            account. Workspace files, conversations, memories, skills,
            credentials, and trust rules are scoped to your account and
            isolated from every other user.
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400">
            <li>
              Vellum staff access to your account is restricted to
              operational purposes (incident response, abuse prevention)
              and is logged.
            </li>
            <li>
              Outbound traffic to AI model providers, channel platforms
              (Telegram, Slack, etc.), and the services your assistant
              calls follows the published terms of those providers. Your
              inputs are not used to train their models under their
              commercial APIs.
            </li>
            <li>
              The Share Feedback button is the only path that explicitly
              sends conversation logs to Vellum, and only when you click
              it.
            </li>
          </ul>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            For the full breakdown, see{" "}
            <Link
              href={"/docs/trust-security/privacy-and-data"}
              className="font-semibold text-emerald-700 underline hover:text-emerald-800"
            >
              Privacy and data
            </Link>
            . If keeping your data off third-party infrastructure is a
            hard requirement, look at{" "}
            <Link
              href={"/docs/hosting-options/local-hosting"}
              className="font-semibold text-emerald-700 underline hover:text-emerald-800"
            >
              local hosting
            </Link>{" "}
            instead.
          </p>
        </section>

        <section id="reaching-your-machine" className="mt-12">
          <SectionHeading id="reaching-your-machine" level={2}>
            Reaching your machine
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            A common question: if my assistant is running in the cloud,
            can it still touch my Mac? Yes, but only when you&apos;re
            connected and only with explicit permission.
          </p>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            The distinction is between tools that run on the
            assistant&apos;s computer (the cloud container) versus tools
            that run on yours (your Mac, through the desktop app):
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400">
            <li>
              <code>bash</code> runs commands inside the assistant&apos;s
              cloud container.
            </li>
            <li>
              <code>host_bash</code>, <code>host_file_*</code>, computer
              use, and screen watch run on <em>your</em> machine, tunneled
              through the desktop app.
            </li>
          </ul>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            If your laptop is closed, your assistant can still do its own
            work (run schedules, process channel messages, research,
            write to its workspace), but the host_*  and computer-use
            tools wait until you&apos;re back at your desktop. The
            assistant always knows which surface it&apos;s reachable on
            and adjusts what it offers to do accordingly.
          </p>
        </section>

        <section id="connecting-to-your-assistant" className="mt-12">
          <SectionHeading id="connecting-to-your-assistant" level={2}>
            Connecting to your assistant
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Surface and hosting are independent axes. With Cloud, you
            have two first-class surfaces to talk to your assistant:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400">
            <li>
              <strong>Web app.</strong> Sign in at{" "}
              <Link
                href="https://vellum.ai"
                className="font-semibold text-emerald-700 underline hover:text-emerald-800"
              >
                vellum.ai
              </Link>{" "}
              from any browser. Full chat, voice, approvals, and
              workspace browsing. No install required.
            </li>
            <li>
              <strong>Desktop app.</strong> Install the Vellum desktop
              app on your Mac, sign in to the same account, and you get
              the same assistant plus the host_* and computer-use tools
              that need direct access to your machine.
            </li>
          </ul>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Both surfaces talk to the same underlying cloud assistant,
            with the same memory and the same workspace. You can switch
            between them mid-thought.
          </p>
        </section>

        <section
          id="when-cloud-is-the-right-choice"
          className="mt-12"
        >
          <SectionHeading
            id="when-cloud-is-the-right-choice"
            level={2}
          >
            When Cloud is the right choice
          </SectionHeading>
          <p className="mb-3 text-stone-600 dark:text-stone-400">
            Cloud hosting is the right call if:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400">
            <li>You want your assistant available 24/7, not just when your laptop is open.</li>
            <li>You want to use voice, phone, Telegram, Slack, or email channels reliably.</li>
            <li>You want Vellum to handle infrastructure, uptime, and updates.</li>
            <li>You want to reach your assistant from multiple devices.</li>
            <li>You don&apos;t have a strict requirement to keep all data on hardware you control.</li>
          </ul>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Look at{" "}
            <Link
              href={"/docs/hosting-options/local-hosting"}
              className="font-semibold text-emerald-700 underline hover:text-emerald-800"
            >
              local hosting
            </Link>{" "}
            instead if you need maximum data control or fully offline
            operation, or at{" "}
            <Link
              href={"/docs/hosting-options/advanced-options"}
              className="font-semibold text-emerald-700 underline hover:text-emerald-800"
            >
              advanced options
            </Link>{" "}
            if you want 24/7 availability on your own infrastructure.
          </p>
        </section>

        <section id="getting-started" className="mt-12">
          <SectionHeading id="getting-started" level={2}>
            Getting started
          </SectionHeading>
          <ol className="mb-0 list-decimal space-y-2 pl-6 text-stone-600 dark:text-stone-400">
            <li>
              Sign in at{" "}
              <Link
                href="https://vellum.ai"
                className="font-semibold text-emerald-700 underline hover:text-emerald-800"
              >
                vellum.ai
              </Link>
              . Your cloud assistant is provisioned automatically.
            </li>
            <li>
              Walk through onboarding to name your assistant and shape
              its identity, then start chatting from the web.
            </li>
            <li>
              Optional: install the{" "}
              <a
                href="https://www.vellum.ai/download"
                className="font-semibold text-emerald-700 underline hover:text-emerald-800"
              >
                desktop app
              </a>{" "}
              if you want host tools and computer use.
            </li>
            <li>
              Optional: connect{" "}
              <Link
                href={"/docs/key-concepts/channels"}
                className="font-semibold text-emerald-700 underline hover:text-emerald-800"
              >
                channels
              </Link>{" "}
              (phone, Telegram, Slack, email) so your assistant can
              reach you anywhere.
            </li>
          </ol>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
