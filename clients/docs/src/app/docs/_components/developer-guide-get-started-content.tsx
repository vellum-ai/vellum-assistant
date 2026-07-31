"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "who-this-is-for", label: "Who this is for", level: 2 },
  { id: "the-two-paths", label: "The two paths", level: 2 },
  { id: "the-repos", label: "The repos", level: 2 },
  { id: "local-development-setup", label: "Local development setup", level: 2 },
  { id: "talking-to-your-assistant", label: "Talking to your assistant programmatically", level: 2 },
  { id: "cli", label: "CLI", level: 3 },
  { id: "http-api", label: "HTTP API", level: 3 },
  { id: "sse-event-stream", label: "SSE event stream", level: 3 },
  { id: "where-to-go-next", label: "Where to go next", level: 2 },
];

const linkClass =
  "font-semibold text-emerald-700 underline hover:text-emerald-800";

export function DeveloperGuideGetStartedContent() {
  return (
    <>
      <DocsContent
        title="Get Started"
        breadcrumb="Docs / Developer Guide / Get Started"
      >
        <p className="mb-8 text-zinc-600">
          A short on-ramp for developers and contributors. Covers the
          repo layout, how to run the assistant locally for development,
          and how to talk to it programmatically through the CLI and the
          HTTP API.
        </p>

        <section id="who-this-is-for">
          <SectionHeading id="who-this-is-for" level={2}>
            Who this is for
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            This page is for developers who want to go beyond the
            shipping product:
          </p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Contributors</strong> working on the assistant
              runtime, the macOS or iOS clients, the gateway, the CLI,
              or the platform web app.
            </li>
            <li>
              <strong>Integrators</strong> building skills, automations,
              or tools on top of an existing assistant.
            </li>
            <li>
              <strong>Advanced users</strong> who want to script their
              assistant or run it locally with full visibility into how
              it works.
            </li>
          </ul>
        </section>

        <section id="the-two-paths" className="mt-12">
          <SectionHeading id="the-two-paths" level={2}>
            The two paths
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Most developer work happens against a{" "}
            <strong>local install</strong>. The assistant runtime, the
            gateway, the credential service, and the workspace all run
            on your Mac, so you can read state, attach a debugger, and
            iterate without round-tripping through Vellum&apos;s
            infrastructure. Everything below assumes a local install
            unless noted.
          </p>
          <p className="mb-0 text-zinc-600">
            Vellum Cloud is the same software running on managed
            infrastructure. The HTTP API is gated behind the platform
            gateway in cloud mode, not exposed directly, so for raw API
            development you&apos;ll want a local install. See{" "}
            <Link
              href={"/docs/hosting-options/cloud-hosting"}
              className={linkClass}
            >
              Cloud hosting
            </Link>{" "}
            and{" "}
            <Link
              href={"/docs/hosting-options/local-hosting"}
              className={linkClass}
            >
              Local hosting
            </Link>{" "}
            for the full comparison.
          </p>
        </section>

        <section id="the-repos" className="mt-12">
          <SectionHeading id="the-repos" level={2}>
            The repos
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Most developer work happens in{" "}
            <strong>vellum-assistant</strong>, the open-source repo that
            holds the assistant runtime and everything that ships with
            it:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <code>assistant/</code>: the TypeScript runtime
              (conversations, memory, tools, channels, schedules)
            </li>
            <li>
              <code>gateway/</code>: the network guard rail that fronts
              the runtime
            </li>
            <li>
              <code>cli/</code>: the <code>vellum</code> command line
              interface
            </li>
            <li>
              <code>credential-executor/</code>: the isolated Credential
              Execution Service
            </li>
            <li>
              <code>skills/</code>: bundled and example skills
            </li>
            <li>
              <code>clients/macos/</code>: the macOS desktop app
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            See{" "}
            <Link
              href={"/docs/developer-guide/architecture"}
              className={linkClass}
            >
              Architecture
            </Link>{" "}
            for how the pieces fit together.
          </p>
        </section>

        <section id="local-development-setup" className="mt-12">
          <SectionHeading id="local-development-setup" level={2}>
            Local development setup
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The fastest way to get a working assistant on your Mac is
            through the desktop app installer, which provisions the
            local runtime, gateway, and credential service for you.
            From there you can swap in your own builds.
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              Install the{" "}
              <a href="https://www.vellum.ai/download" className={linkClass}>
                desktop app
              </a>{" "}
              and walk through onboarding. Your workspace will live at{" "}
              <code>~/.vellum/</code>.
            </li>
            <li>
              Clone <code>vellum-assistant</code> alongside it. Use the
              repo&apos;s top-level setup scripts to install
              dependencies and link your local build into the running
              installation.
            </li>
            <li>
              Verify with{" "}
              <code>vellum ps</code>: you should see the{" "}
              <code>assistant</code>, <code>gateway</code>, and{" "}
              <code>credential-executor</code> processes running.
            </li>
          </ol>
          <p className="mb-0 text-zinc-600">
            For the full development loop, including parallel agents
            and the review pipeline, see{" "}
            <Link
              href={"/docs/developer-guide/development-workflow"}
              className={linkClass}
            >
              Development Workflow
            </Link>
            .
          </p>
        </section>

        <section id="talking-to-your-assistant" className="mt-12">
          <SectionHeading id="talking-to-your-assistant" level={2}>
            Talking to your assistant programmatically
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Three options, in order of how much ceremony they require.
          </p>

          <div id="cli" className="mb-8">
            <SectionHeading id="cli" level={3}>
              CLI
            </SectionHeading>
            <p className="mb-3 text-zinc-600">
              The <code>vellum</code> CLI is the highest-level
              interface. It reads your local credentials and routes
              commands to the running assistant.
            </p>
            <pre className="mb-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
              <code>{`# send a message and stream the response
vellum message "summarize today's calendar"

# tail the live event stream
vellum events

# inspect process state
vellum ps`}</code>
            </pre>
            <p className="mb-0 text-zinc-600">
              Useful subcommands include <code>login</code>,{" "}
              <code>setup</code>, <code>hatch</code>,{" "}
              <code>message</code>, <code>events</code>,{" "}
              <code>logs</code>, <code>ps</code>, <code>terminal</code>,
              and <code>retire</code>. Run{" "}
              <code>vellum --help</code> to see the full list.
            </p>
          </div>

          <div id="http-api" className="mb-8">
            <SectionHeading id="http-api" level={3}>
              HTTP API
            </SectionHeading>
            <p className="mb-3 text-zinc-600">
              The runtime exposes a versioned REST API at{" "}
              <code>/v1</code>. On a local install the assistant listens
              on a loopback port; the CLI handles auth for you, but you
              can also call the API directly with a JWT bearer token.
            </p>
            <pre className="mb-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
              <code>{`# list conversations
curl -H "Authorization: Bearer $VELLUM_JWT" \\
     http://127.0.0.1:7821/v1/conversations

# post a message into a conversation
curl -X POST \\
     -H "Authorization: Bearer $VELLUM_JWT" \\
     -H "Content-Type: application/json" \\
     -d '{"text": "hello"}' \\
     http://127.0.0.1:7821/v1/messages`}</code>
            </pre>
            <p className="mb-0 text-zinc-600">
              Auth is JWT-only: every request needs an{" "}
              <code>Authorization: Bearer</code> header carrying a
              token signed by the gateway. See{" "}
              <Link
                href={"/docs/developer-guide/security"}
                className={linkClass}
              >
                Security &amp; Permissions
              </Link>{" "}
              for the full auth model.
            </p>
          </div>

          <div id="sse-event-stream">
            <SectionHeading id="sse-event-stream" level={3}>
              SSE event stream
            </SectionHeading>
            <p className="mb-3 text-zinc-600">
              Long-lived clients subscribe to a server-sent events
              stream to receive streaming model output, tool calls,
              approval prompts, and channel events as they happen.
            </p>
            <pre className="mb-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
              <code>{`curl -N \\
     -H "Authorization: Bearer $VELLUM_JWT" \\
     http://127.0.0.1:7821/v1/events`}</code>
            </pre>
            <p className="mb-0 text-zinc-600">
              See{" "}
              <Link
                href={"/docs/developer-guide/api"}
                className={linkClass}
              >
                API &amp; Communication
              </Link>{" "}
              for the full event-type catalog, connection management,
              and a JavaScript reference client.
            </p>
          </div>
        </section>

        <section id="where-to-go-next" className="mt-12">
          <SectionHeading id="where-to-go-next" level={2}>
            Where to go next
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <Link
                href={"/docs/developer-guide/architecture"}
                className={linkClass}
              >
                Architecture
              </Link>
              : platform domains, repo structure, and how the runtime,
              clients, and gateway fit together.
            </li>
            <li>
              <Link
                href={"/docs/developer-guide/security"}
                className={linkClass}
              >
                Security &amp; Permissions
              </Link>
              : sandbox model, credential storage, trust rules, and
              JWT auth.
            </li>
            <li>
              <Link
                href={"/docs/developer-guide/features"}
                className={linkClass}
              >
                Features &amp; Capabilities
              </Link>
              : integrations, dynamic skill authoring, browser
              automation, attachments.
            </li>
            <li>
              <Link
                href={"/docs/developer-guide/api"}
                className={linkClass}
              >
                API &amp; Communication
              </Link>
              : SSE event stream, payloads, connection management.
            </li>
            <li>
              <Link
                href={"/docs/developer-guide/development-workflow"}
                className={linkClass}
              >
                Development Workflow
              </Link>
              : Claude Code commands, parallel PR execution, the
              release pipeline.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
