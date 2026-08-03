"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "your-assistant-is-ready", label: "Your assistant is ready", level: 2 },
  { id: "where-to-talk-to-it", label: "Where to talk to it", level: 2 },
  { id: "what-to-say-first", label: "What to say first", level: 2 },
  { id: "give-it-a-real-task", label: "Give it a real task", level: 2 },
  { id: "approvals", label: "Approvals", level: 2 },
  { id: "what-it-remembers", label: "What it remembers", level: 2 },
  { id: "connect-more-places", label: "Connect more places", level: 2 },
  { id: "where-to-go-next", label: "Where to go next", level: 2 },
];

const linkClass =
  "font-semibold text-emerald-700 underline hover:text-emerald-800";

function MigrationCallout() {
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3">
      <p className="mb-1 text-xs font-semibold text-emerald-800">
        Coming from OpenClaw or Hermes?
      </p>
      <p className="mb-2 text-xs leading-relaxed text-emerald-700">
        There&apos;s a migration tool to bring over your data, memories, and settings in one pass.
      </p>
      <Link
        href="https://www.vellum.ai/import"
        className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 underline hover:text-emerald-800"
      >
        Migration tool
        <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}

export function QuickStartContent() {
  return (
    <>
      <DocsContent
        title="Quick Start"
        breadcrumb="Docs / Getting Started / Quick Start"
      >
        <p className="mb-8 text-zinc-600">
          You&apos;ve installed Vellum. Now what? This page walks
          through how to actually start using your assistant after the
          install completes, whether you signed up for Vellum Cloud or
          set up a local install on your Mac.
        </p>

        <section id="your-assistant-is-ready">
          <SectionHeading id="your-assistant-is-ready" level={2}>
            Your assistant is ready
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            When the install finishes, your assistant is provisioned
            and waiting. It&apos;s a blank slate. No name, no memories,
            no preferences, nothing yet. The more you work together,
            the more context it builds and the more useful it becomes.
          </p>
          <p className="mb-0 text-zinc-600">
            There&apos;s no onboarding wizard. Just a chat box. Type
            something, ask a question, give it a task. That&apos;s how
            it learns about you.
          </p>
        </section>

        <section id="where-to-talk-to-it" className="mt-12">
          <SectionHeading id="where-to-talk-to-it" level={2}>
            Where to talk to it
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            On Vellum Cloud, your assistant is the same wherever you
            sign in, with the same memory and the same conversation
            history carried across:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Web</strong>: open{" "}
              <a href="https://vellum.ai" className={linkClass}>
                vellum.ai
              </a>{" "}
              in any browser. No install needed.
            </li>
            <li>
              <strong>iPhone or iPad</strong>: install the Vellum
              Assistant app from the{" "}
              <a
                href="https://apps.apple.com/us/app/vellum-assistant/id6759934423"
                className={linkClass}
              >
                App Store
              </a>{" "}
              and sign in.
            </li>
            <li>
              <strong>Mac</strong>: install the{" "}
              <Link href="https://www.vellum.ai/download" className={linkClass}>
                desktop app
              </Link>
              . Same assistant, with the added ability to read your
              local files and control your Mac when you ask it to.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            On a local install, your assistant lives on your Mac
            through the desktop app. Beyond that, you can hook up
            Telegram, Slack, email, and phone calls so your assistant
            can reach you outside of those first-party surfaces. See{" "}
            <Link
              href="/docs/key-concepts/channels"
              className={linkClass}
            >
              Channels
            </Link>{" "}
            for the full set.
          </p>
        </section>

        <section id="what-to-say-first" className="mt-12">
          <SectionHeading id="what-to-say-first" level={2}>
            What to say first
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            There&apos;s no wrong answer. A few good first moves:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Give it a name.</strong> &ldquo;Your name is
              Bob.&rdquo; That name will stick.
            </li>
            <li>
              <strong>Tell it about yourself.</strong> &ldquo;I&apos;m
              Alice. I work in marketing, live in Brooklyn, and prefer
              short, direct answers.&rdquo; That&apos;s the kind of
              context it folds into how it talks to you.
            </li>
            <li>
              <strong>Ask what it can do.</strong> &ldquo;What are you
              good at?&rdquo; or &ldquo;What tools do you have?&rdquo;
              It&apos;ll walk you through its current capabilities.
            </li>
            <li>
              <strong>Shape its style.</strong> &ldquo;Be more casual,
              less corporate. Don&apos;t hedge.&rdquo; Style notes
              persist across conversations.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            None of this is required. You can also just dive into a
            real task and let it pick up your context as it goes.
          </p>
        </section>

        <section id="give-it-a-real-task" className="mt-12">
          <SectionHeading id="give-it-a-real-task" level={2}>
            Give it a real task
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The best way to see what your assistant can do is to give
            it something you actually need. Some examples:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              &ldquo;Draft a follow-up email to Alice about the launch
              meeting we had this morning.&rdquo;
            </li>
            <li>
              &ldquo;Help me think through whether to take the new
              role.&rdquo;
            </li>
            <li>
              &ldquo;Summarize what&apos;s on my calendar this
              week.&rdquo;
            </li>
            <li>
              &ldquo;Build me a simple expense tracker I can use in
              the browser.&rdquo;
            </li>
            <li>
              &ldquo;Remind me at 4pm to drink water.&rdquo;
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            If a task needs a tool your assistant doesn&apos;t have set
            up yet (your calendar, your email, etc.), it&apos;ll tell
            you what it needs and walk you through connecting it.
          </p>
        </section>

        <section id="approvals" className="mt-12">
          <SectionHeading id="approvals" level={2}>
            Approvals
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The first time your assistant tries to do something that
            could matter (sending an email, saving a file, scheduling
            something on your calendar), it&apos;ll stop and ask you
            first. You see exactly what it wants to do and you click
            Allow or Deny.
          </p>
          <p className="mb-4 text-zinc-600">
            If you&apos;re using voice, it asks the same question out
            loud and you say yes or no. On iPhone, the prompt comes
            through as a notification you can tap.
          </p>
          <p className="mb-0 text-zinc-600">
            You can also set up trust rules so it stops asking about
            things you&apos;ve already approved. For the full picture,
            see{" "}
            <Link
              href="/docs/trust-security/the-permissions-model"
              className={linkClass}
            >
              The permissions model
            </Link>
            .
          </p>
        </section>

        <section id="what-it-remembers" className="mt-12">
          <SectionHeading id="what-it-remembers" level={2}>
            What it remembers
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Anything you tell it, anything it figures out about you,
            anything that comes up in conversation that&apos;s likely
            to matter later, it stores as a memory. Memories surface in
            future conversations when they&apos;re relevant, so you
            don&apos;t have to repeat yourself.
          </p>
          <p className="mb-0 text-zinc-600">
            You can ask &ldquo;What do you remember about me?&rdquo;
            anytime. You can also tell it to forget something:
            &ldquo;Forget what I told you about that project.&rdquo;
            See{" "}
            <Link
              href="/docs/key-concepts/memory-and-context"
              className={linkClass}
            >
              Memory &amp; Context
            </Link>{" "}
            for how it works.
          </p>
        </section>

        <section id="connect-more-places" className="mt-12">
          <SectionHeading id="connect-more-places" level={2}>
            Connect more places
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your assistant can also reach you outside of the apps. Most
            people set up at least one of these in their first week:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Telegram</strong>: chat with your assistant from
              any device that has Telegram installed.
            </li>
            <li>
              <strong>Slack</strong>: put your assistant in a Slack DM
              or workspace.
            </li>
            <li>
              <strong>Phone calls</strong>: your assistant gets a real
              phone number you can call.
            </li>
            <li>
              <strong>Email</strong>: your assistant gets its own email
              address it can send and receive on.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Setup is a few minutes per channel and runs through a
            verification handshake so only you can claim the
            connection. See{" "}
            <Link
              href="/docs/key-concepts/channels"
              className={linkClass}
            >
              Channels
            </Link>
            .
          </p>
        </section>

        <section id="where-to-go-next" className="mt-12">
          <SectionHeading id="where-to-go-next" level={2}>
            Where to go next
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <Link
                href="/docs/key-concepts"
                className={linkClass}
              >
                Key Concepts
              </Link>
              : the workspace, memory, channels, tools, scheduling.
              The mental model behind how your assistant works.
            </li>
            <li>
              <Link
                href="/docs/getting-started/your-first-skill"
                className={linkClass}
              >
                Your first skill
              </Link>
              : how to add a new capability, like a new integration or
              a custom workflow.
            </li>
            <li>
              <Link
                href="/docs/trust-security/security-best-practices"
                className={linkClass}
              >
                Security best practices
              </Link>
              : the practical guide to staying safe while giving your
              assistant useful access.
            </li>
            <li>
              <Link
                href="/docs/help/faq"
                className={linkClass}
              >
                FAQ
              </Link>
              : answers to the questions most people have in their
              first week.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} footer={<MigrationCallout />} />
    </>
  );
}
