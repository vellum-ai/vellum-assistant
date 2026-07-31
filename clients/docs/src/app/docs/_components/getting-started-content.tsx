"use client";

import { routes } from "@/lib/routes";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";


const TOC_ITEMS = [
  { id: "what-you-need", label: "What you need", level: 2 },
  { id: "web", label: "Web", level: 2 },
  { id: "ios-app", label: "iOS app", level: 2 },
  { id: "desktop-app", label: "Desktop app", level: 2 },
  { id: "self-hosting", label: "Self-hosting", level: 2 },
  { id: "two-ways-to-connect", label: "Two ways to connect", level: 2 },
  { id: "what-gets-installed", label: "What gets installed", level: 2 },
  { id: "permissions", label: "Permissions", level: 2 },
  { id: "updates", label: "Updates", level: 2 },
  { id: "definitions", label: "Definitions", level: 2 },
];

export function GettingStartedContent() {
  return (
    <>
      <DocsContent title="Installation" breadcrumb="Docs / Getting Started / Installation">
        <section id="what-you-need">
          <SectionHeading id="what-you-need" level={2}>
            What you need
          </SectionHeading>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>For the web app:</strong> any modern browser. No install, no setup. The
              fastest way in. Connects to a cloud assistant.
            </li>
            <li>
              <strong>For the iOS app:</strong> an iPhone or iPad and your Vellum account.
              Connects to your cloud assistant.
            </li>
            <li>
              <strong>For the desktop app:</strong> macOS 15 (Sequoia) or later, Apple Silicon
              or Intel, plus ~500 MB free disk space. Connects to a cloud or local assistant.
            </li>
            <li>
              Internet connection (your assistant uses cloud AI models to think)
            </li>
            <li>
              About 5 minutes and a willingness to talk to your computer
            </li>
          </ul>
          <p className="mb-6 text-zinc-600">
            <a href={routes.signup} className="font-semibold text-emerald-700 underline hover:text-emerald-800">
              Sign up
            </a>{" "}
            and your assistant is provisioned in seconds.
          </p>
        </section>

        <section id="web" className="mt-12">
          <SectionHeading id="web" level={2}>
            Web
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The fastest way to meet your assistant. No install, no setup wizard, no config
            files. Your assistant runs in Vellum Cloud and you reach it from your browser.
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              Go to{" "}
              <a href={routes.signup} className="font-semibold text-emerald-700 underline hover:text-emerald-800">
                vellum.ai/signup
              </a>{" "}
              and create your account.
            </li>
            <li>
              Set your privacy preferences and accept the Terms of Service.
            </li>
            <li>
              Watch your assistant hatch in the browser. About 30 seconds.
            </li>
            <li>
              Say hi.
            </li>
          </ol>
          <p className="mb-4 text-zinc-600">
            Your assistant lives in Vellum Cloud, encrypted and isolated to your account,
            reachable from any browser. You can also connect the desktop app, mobile app, voice,
            and chat channels (Telegram, Slack, phone) to the same assistant.
          </p>
        </section>

        <section id="ios-app" className="mt-12">
          <SectionHeading id="ios-app" level={2}>
            iOS app
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Install Vellum Assistant on your iPhone or iPad to use the same assistant,
            conversations, memories, tools, and workspace you have on the web and Mac.
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              Install Vellum Assistant from the{" "}
              <a
                href="https://apps.apple.com/us/app/vellum-assistant/id6759934423"
                className="font-semibold text-emerald-700 underline hover:text-emerald-800"
              >
                App Store
              </a>
              .
            </li>
            <li>Open the app and sign in with your Vellum account.</li>
            <li>Your cloud assistant appears automatically. Say hi.</li>
          </ol>
          <p className="mb-6 text-zinc-600">
            Approval requests can arrive as mobile notifications, so you can review
            sensitive actions from your phone.
          </p>
        </section>

        <section id="desktop-app" className="mt-12">
          <SectionHeading id="desktop-app" level={2}>
            Desktop app
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The desktop app gives you a menu bar presence, voice input with hold-to-talk, and
            the ability to control your Mac through accessibility APIs. It connects to a
            cloud assistant by default (so your conversations and memory show up in both the
            web and desktop apps), but it can also run a local assistant entirely on your
            machine. See{" "}
            <a href="/docs/hosting-options" className="font-semibold text-emerald-700 underline hover:text-emerald-800">
              Hosting options
            </a>{" "}
            for the local-only setup.
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              <a href={routes.signup} className="font-semibold text-emerald-700 underline hover:text-emerald-800">
                Sign up
              </a>{" "}
              for Vellum if you haven&apos;t already.
            </li>
            <li>
              Download the macOS <code>.dmg</code> from your account dashboard.
            </li>
            <li>
              Open the <code>.dmg</code>, drag Vellum to Applications, and launch it.
            </li>
            <li>
              Sign in with your Vellum account. Your cloud assistant shows up automatically.
            </li>
          </ol>
          <p className="mb-6 text-zinc-600">
            That&apos;s the whole process. No terminal commands, no package managers, no YAML
            files. Standard <code>.dmg</code>, signed and notarized.
          </p>
        </section>

        <section id="self-hosting" className="mt-12">
          <SectionHeading id="self-hosting" level={2}>
            Self-hosting
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Want to run Vellum entirely on your own machine or your own infrastructure? You can.
            The runtime is open source and supports local-only mode (workspace at{" "}
            <code>~/.vellum/workspace/</code>) as well as remote deployment to your own GCP or
            AWS environment.
          </p>
          <p className="mb-6 text-zinc-600">
            Head to{" "}
            <a href="/docs/hosting-options" className="font-semibold text-emerald-700 underline hover:text-emerald-800">
              Hosting options
            </a>{" "}
            for the full guide on local hosting and advanced deployment.
          </p>
        </section>

        <section id="two-ways-to-connect" className="mt-12">
          <SectionHeading id="two-ways-to-connect" level={2}>
            Two ways to connect
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Sign in with Vellum (default)</strong> — Authenticate with your Vellum
              account for the managed experience. Your assistant runs in Vellum Cloud, billing
              is handled through your account, no API keys to manage.
            </li>
            <li>
              <strong>Bring your own API key</strong> — Self-host the runtime and connect it to
              your own Anthropic API key. Useful if you want to run everything on your own
              machine. Your key is stored in your macOS Keychain.
            </li>
          </ul>
        </section>

        <section id="what-gets-installed" className="mt-12">
          <SectionHeading id="what-gets-installed" level={2}>
            What gets installed
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            If you run the desktop app or self-host, Vellum creates one directory on your
            machine. (Vellum Cloud users don&apos;t need to think about this. Your workspace
            lives in your encrypted cloud account and is available through the web app.)
          </p>
          <div className="mb-6 overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-950 p-4">
            <pre className="font-[family-name:var(--font-dm-mono)] text-sm text-zinc-100">
{`~/.vellum/
├── workspace/
│   ├── IDENTITY.md        # Name, personality, emoji
│   ├── SOUL.md            # Principles and behavior rules
│   ├── USER.md            # What the assistant knows about you
│   ├── NOW.md             # Current focus, goals, and context
│   ├── config.json        # Runtime configuration
│   ├── skills/            # Installed and custom skills
│   └── data/
│       └── db/
│           └── assistant.db   # Conversations, memory, schedules (SQLite)
├── lockfile.json          # Running assistant instances and ports`}
            </pre>
          </div>
          <p className="mb-3 text-zinc-600">
            Everything is plain text (aside from the SQLite database). You can open these files in
            any editor, read them, change them, even put them in version control. Your
            assistant&apos;s brain is not a black box. It&apos;s a folder on your computer.
          </p>
          <p className="mb-6 text-zinc-600">
            Session logs are stored in{" "}
            <code>~/Library/Application Support/vellum-assistant/logs/</code>. The daemon binary
            lives inside the <code>.app</code> bundle, not in <code>~/.vellum/</code>.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Vellum doesn&apos;t ask for all its permissions upfront. Instead, permissions are
            requested only when they&apos;re actually needed:
          </p>
          <div className="mb-6 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Permission
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Purpose
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    When requested
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2">
                    <strong>Screen Recording</strong>
                  </td>
                  <td className="px-3 py-2">
                    See your screen for computer-use tasks
                  </td>
                  <td className="px-3 py-2">
                    First time your assistant needs to see your screen
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Microphone</strong>
                  </td>
                  <td className="px-3 py-2">
                    Voice input (hold Fn to talk)
                  </td>
                  <td className="px-3 py-2">
                    First time you use voice input
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Speech Recognition</strong>
                  </td>
                  <td className="px-3 py-2">
                    Convert voice to text
                  </td>
                  <td className="px-3 py-2">
                    First time you use voice input
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Accessibility</strong>
                  </td>
                  <td className="px-3 py-2">
                    Control your Mac (click, type, navigate)
                  </td>
                  <td className="px-3 py-2">
                    First time your assistant needs to interact with your apps
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <strong>Notifications</strong>
                  </td>
                  <td className="px-3 py-2">
                    Status updates and reminders
                  </td>
                  <td className="px-3 py-2">
                    Optional, on first notification
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-6 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            <strong>Worth knowing:</strong> The app accesses files through normal sandbox
            entitlements, not Full Disk Access. Individual file and shell actions still require
            your approval through the in-app permission system. Check out{" "}
            <a href="/docs/trust-security">Trust &amp; Security</a> for the full picture.
          </p>
        </section>

        <section id="updates" className="mt-12">
          <SectionHeading id="updates" level={2}>
            Updates
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Vellum checks for updates automatically in the background. When an update is
            available, you&apos;ll see a green update button in the top right corner of the app. You can install
            immediately or defer until later. Updates are signed and verified before
            installation.
          </p>
        </section>


        <section id="definitions" className="mt-12">
          <SectionHeading id="definitions" level={2}>
            Definitions
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Key terms and concepts used throughout the Vellum Assistant ecosystem.
          </p>
          <dl className="space-y-4">
            <div className="rounded-xl border border-zinc-200 p-4 transition-colors hover:border-zinc-300">
              <dt className="mb-1 font-['DM_Sans',sans-serif] font-semibold text-zinc-900">
                <a href="/docs/getting-started/what-is-vellum">Assistant</a>
              </dt>
              <dd className="m-0 text-sm text-zinc-600">
                An AI-powered agent configured to perform tasks on your behalf. Each assistant is
                backed by a large language model and can be customized with specific instructions,
                skills, and channels.
              </dd>
            </div>
            <div className="rounded-xl border border-zinc-200 p-4 transition-colors hover:border-zinc-300">
              <dt className="mb-1 font-['DM_Sans',sans-serif] font-semibold text-zinc-900">
                <a href="/docs/key-concepts/channels">Channel</a>
              </dt>
              <dd className="m-0 text-sm text-zinc-600">
                The surface through which users interact with the assistant. Channels include the
                desktop app, command-line tool, and other application integrations like Telegram.
              </dd>
            </div>
            <div className="rounded-xl border border-zinc-200 p-4 transition-colors hover:border-zinc-300">
              <dt className="mb-1 font-['DM_Sans',sans-serif] font-semibold text-zinc-900">
                <a href="/docs/hosting-options">Environment</a>
              </dt>
              <dd className="m-0 text-sm text-zinc-600">
                The runtime context in which an assistant operates.
              </dd>
            </div>
            <div className="rounded-xl border border-zinc-200 p-4 transition-colors hover:border-zinc-300">
              <dt className="mb-1 font-['DM_Sans',sans-serif] font-semibold text-zinc-900">
                Guardian
              </dt>
              <dd className="m-0 text-sm text-zinc-600">
                The user who is in charge of the assistant. The guardian oversees the assistant&apos;s
                behavior, manages its configuration, and ensures it operates within defined boundaries.
              </dd>
            </div>
            <div className="rounded-xl border border-zinc-200 p-4 transition-colors hover:border-zinc-300">
              <dt className="mb-1 font-['DM_Sans',sans-serif] font-semibold text-zinc-900">
                Hatch
              </dt>
              <dd className="m-0 text-sm text-zinc-600">
                The process of creating and initializing a new assistant. When you hatch an
                assistant, it is configured and made ready to receive messages.
              </dd>
            </div>
            <div className="rounded-xl border border-zinc-200 p-4 transition-colors hover:border-zinc-300">
              <dt className="mb-1 font-['DM_Sans',sans-serif] font-semibold text-zinc-900">
                Retire
              </dt>
              <dd className="m-0 text-sm text-zinc-600">
                The process of deactivating an assistant. Retiring an assistant stops it from
                receiving new messages and frees up associated resources.
              </dd>
            </div>
            <div className="rounded-xl border border-zinc-200 p-4 transition-colors hover:border-zinc-300">
              <dt className="mb-1 font-['DM_Sans',sans-serif] font-semibold text-zinc-900">
                <a href="/docs/key-concepts/skills-and-tools">Skill</a>
              </dt>
              <dd className="m-0 text-sm text-zinc-600">
                An action or capability that the assistant can invoke during a conversation. Skills
                allow the assistant to interact with external systems, run code, search the web,
                and more.
              </dd>
            </div>
          </dl>
        </section>

      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
