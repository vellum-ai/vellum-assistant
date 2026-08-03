"use client";

import Link from "next/link";

import { routes } from "@/lib/routes";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "about-the-product", label: "About the product", level: 2 },
  { id: "about-privacy-and-data", label: "About privacy and data", level: 2 },
  { id: "about-capabilities", label: "About capabilities", level: 2 },
  { id: "about-the-assistant-itself", label: "About the assistant itself", level: 2 },
];

export function HelpFaqContent() {
  return (
    <>
      <DocsContent title="FAQ" breadcrumb="Docs / Help / FAQ">
        <section id="about-the-product">
          <SectionHeading id="about-the-product" level={2}>
            About the product
          </SectionHeading>

          <SectionHeading id="what-is-vellum" level={3}>
            What is Vellum?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            A personal AI assistant that lives on your computer. It can take real actions on your
            behalf: reading files, sending emails, browsing the web, controlling your Mac, building
            apps, managing your schedule, making phone calls, and more. It has its own identity,
            personality, and long-term memory that persists across conversations. See{" "}
            <a href="/docs/getting-started/what-is-vellum">What is Vellum?</a> for the full
            overview.
          </p>

          <SectionHeading id="how-is-this-different-from-chatgpt-or-claude" level={3}>
            How is this different from ChatGPT or Claude?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Those are conversation tools. You type, they respond, you copy-paste the answer
            somewhere. Vellum is different because it has tools (it can actually do things on your
            computer and across services), memory (it remembers you across conversations with a
            full hybrid search system), a persistent identity (its own personality, name, and
            behavioral rules you can customize), and it reaches you everywhere (desktop,
            Telegram, Slack, voice calls). More detail in{" "}
            <a href="/docs/getting-started/what-is-vellum">What is Vellum?</a>.
          </p>

          <SectionHeading id="is-vellum-free" level={3}>
            Is Vellum free?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            You can run Vellum locally with your own Anthropic API key at no cost beyond your API
            usage. Vellum also offers a managed mode where you sign in with a Vellum account and
            the assistant runs on our platform.
          </p>

          <SectionHeading id="why-does-it-cost-money-when-im-not-using-it" level={3}>
            Why does my assistant cost money when I&apos;m not actively using it?
          </SectionHeading>
          <p className="mb-3 text-zinc-600">
            A big part of how assistants work is that they have their own heartbeat and memory
            system, which performs work in the background even when you&apos;re not chatting with
            them. We&apos;re always working on ways to make this less of a surprise and to cost
            less.
          </p>
          <p className="mb-6 text-zinc-600">
            A lot of it is configurable too. You can ask your assistant to disable or reduce the
            frequency of &ldquo;heartbeats&rdquo; and &ldquo;memory compaction,&rdquo; or to use a
            less expensive model for these background actions.
          </p>

          <SectionHeading id="what-platforms-does-it-support" level={3}>
            What platforms does it support?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            On Vellum Cloud, you can reach your assistant from any modern browser at{" "}
            <Link
              href="https://vellum.ai"
              className="font-semibold text-emerald-700 underline hover:text-emerald-800"
            >
              vellum.ai
            </Link>
            , the iPhone and iPad app, the macOS desktop app, and a
            command-line interface. Beyond those first-party surfaces,
            channels include Telegram, Slack, email, and phone calls.
          </p>

          <SectionHeading id="where-should-i-host" level={3}>
            Where should I host my assistant?
          </SectionHeading>
          <p className="mb-3 text-zinc-600">
            Three paths, picked by what you care about most:
          </p>
          <ul className="mb-3 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>
                <Link
                  href="/docs/hosting-options/cloud-hosting"
                  className="font-semibold text-emerald-700 underline hover:text-emerald-800"
                >
                  Vellum Cloud
                </Link>
              </strong>{" "}
              (recommended). Always on, sandboxed per account, reachable
              from web, desktop, iOS, voice, and chat. Vellum runs the
              infrastructure. The right pick if you want it to just work
              and be available 24/7 across your devices.
            </li>
            <li>
              <strong>
                <Link
                  href="/docs/hosting-options/local-hosting"
                  className="font-semibold text-emerald-700 underline hover:text-emerald-800"
                >
                  Local hosting
                </Link>
              </strong>
              . The assistant runs on your Mac. Your data stays on your
              machine, and the assistant has direct access to your local
              files and tools. The right pick if you want maximum data
              control or fully offline operation, and you&apos;re okay
              with the assistant only being available when your computer
              is awake.
            </li>
            <li>
              <strong>
                <Link
                  href="/docs/hosting-options/advanced-options"
                  className="font-semibold text-emerald-700 underline hover:text-emerald-800"
                >
                  User-Hosted Remote
                </Link>
              </strong>{" "}
              (coming soon). Your own GCP, AWS, or a Mac Mini at home.
              You get 24/7 availability and full data ownership, but you
              manage the infrastructure. The right pick if you&apos;re
              comfortable running cloud yourself and want neither party
              compromise.
            </li>
          </ul>
          <p className="mb-6 text-zinc-600">
            Most users should start on Cloud. You can move later if your
            needs change. See the{" "}
            <Link
              href="/docs/hosting-options"
              className="font-semibold text-emerald-700 underline hover:text-emerald-800"
            >
              Hosting options overview
            </Link>{" "}
            for the full comparison.
          </p>

          <SectionHeading id="can-i-use-it-on-my-phone" level={3}>
            Can I use it on my phone?
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Yes. There&apos;s a native iPhone and iPad app on the{" "}
            <Link
              href="https://apps.apple.com/us/app/vellum-assistant/id6759934423"
              className="font-semibold text-emerald-700 underline hover:text-emerald-800"
            >
              App Store
            </Link>
            , and you can also reach your assistant through Telegram or
            phone calls from any device.
          </p>
        </section>

        <hr className="my-10 border-zinc-200" />

        <section id="about-privacy-and-data">
          <SectionHeading id="about-privacy-and-data" level={2}>
            About privacy and data
          </SectionHeading>

          <SectionHeading id="is-my-data-safe" level={3}>
            Is my data safe?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            On Vellum Cloud (the default), your workspace, memories, and
            credentials live in your private, encrypted cloud account, not
            shared with other users. If you self-host, all of that stays on
            your machine instead, with credentials kept in the macOS Keychain
            or an AES-256-GCM encrypted file, isolated behind a separate
            Credential Execution Service. In both cases, your conversations
            and context are sent to the AI model provider (Anthropic) to
            generate responses. That&apos;s the trade-off we&apos;re
            transparent about. Full details in{" "}
            <a href={routes.docs.legal.privacyAndData}>Privacy &amp; Data</a>.
          </p>

          <SectionHeading id="does-vellum-train-on-my-data" level={3}>
            Does Vellum train on my data?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            No. From our side, your data is not used for training or fine-tuning. Anthropic&apos;s API
            terms also state that API data is not used for model training. We recommend reading{" "}
            <a href="https://www.anthropic.com/legal/privacy">Anthropic&apos;s Privacy Policy</a>{" "}
            directly for the most current details.
          </p>

          <SectionHeading id="does-vellum-collect-telemetry" level={3}>
            Does Vellum collect telemetry?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Only if you opt in. There are two optional toggles in Settings &gt; Privacy: usage
            analytics (anonymized token counts and feature adoption &mdash; no message content) and
            crash diagnostics (error reports via Sentry &mdash; no personal data). Both are off by
            default.
          </p>

          <SectionHeading id="can-my-employer-see-what-i-do-with-vellum" level={3}>
            Can my employer see what I do with Vellum?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Your assistant is yours. Vellum doesn&apos;t have a dashboard, an
            admin panel, or any way for your employer to see your usage.
            That said, if you&apos;re using your employer&apos;s computer or
            network, they could potentially see the API calls or web traffic
            from your assistant. If that&apos;s a concern, self-hosting on a
            personal device is the most private option. Use your judgment
            based on your work environment.
          </p>

          <SectionHeading id="what-happens-if-i-delete-the-app" level={3}>
            What happens if I delete the app?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            On Vellum Cloud, your account and workspace stick around unless
            you ask us to delete them. You can export your workspace at any
            time, or request full deletion through the account settings or
            support. If you self-host, your workspace folder
            (<code>~/.vellum/</code>) stays on your machine until you delete
            it manually; <code>vellum retire</code> from the CLI archives the
            workspace as a tarball before removal. See{" "}
            <a href="/docs/trust-security/security-best-practices">Security Best Practices</a>{" "}
            for the full reset process.
          </p>

          <SectionHeading id="can-other-people-access-my-assistant" level={3}>
            Can other people access my assistant?
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Yes, in a controlled way. You can grant trusted contacts limited access to your
            assistant through channels like Telegram or Slack. Trusted contacts can
            chat with your assistant but can&apos;t access your memories, modify your workspace, or
            use sensitive tools without your explicit approval. Unverified people who message your
            assistant get heavily restricted access. See{" "}
            <a href="/docs/trust-security/the-permissions-model">The Permissions Model</a> for
            details on how trust gating works.
          </p>
        </section>

        <hr className="my-10 border-zinc-200" />

        <section id="about-capabilities">
          <SectionHeading id="about-capabilities" level={2}>
            About capabilities
          </SectionHeading>

          <SectionHeading id="what-can-it-do" level={3}>
            What can it do?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            A lot. Gmail management, Google Calendar, Slack integration, web browsing, computer
            control, phone calls, image generation, coding, app building, document writing, task
            management, screen watching, media processing, and more &mdash; about 30 built-in
            skills in total. You can also build custom skills to extend it further. See the{" "}
            <a href="/docs/skills-reference">Skills Reference</a> for details on each capability.
          </p>

          <SectionHeading id="can-it-access-my-files" level={3}>
            Can it access my files?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Files inside the workspace (<code>~/.vellum/workspace/</code>) are accessible without
            prompts. Files outside the workspace &mdash; on your host machine &mdash; require your
            explicit permission each time. You see what file it wants to access, whether
            it&apos;s a read or write, and can choose to allow once, allow temporarily, or create
            a persistent rule. See{" "}
            <a href="/docs/trust-security/the-permissions-model">The Permissions Model</a>.
          </p>

          <SectionHeading id="can-it-send-emails-as-me" level={3}>
            Can it send emails as me?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            With the Gmail skill, your assistant can draft and send emails from your Gmail account,
            but sending always requires your explicit approval. It creates a draft first, and you
            approve before anything is sent. Your assistant can also use its own email address
            through AgentMail for sending on its own behalf.
          </p>

          <SectionHeading id="can-it-control-my-computer" level={3}>
            Can it control my computer?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Yes, with your permission. The Computer Use skill lets your assistant see your screen
            (via accessibility APIs and screenshots) and control mouse and keyboard input. This
            requires macOS Accessibility and Screen Recording permissions, and each action is
            prompted individually for approval. Sessions are capped at 50 steps with loop detection
            and destructive action blocking. See{" "}
            <a href="/docs/skills-reference/computer-use">Computer Use</a>.
          </p>

          <SectionHeading id="can-i-teach-it-new-things" level={3}>
            Can I teach it new things?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Yes, in three ways. You can tell it facts and preferences naturally in conversation
            (it extracts and saves them to long-term memory automatically). You can edit its
            workspace files directly (SOUL.md for behavior, USER.md for facts about you). And you
            can build custom skills that teach it new workflows and capabilities. See{" "}
            <a href="/docs/key-concepts/skills-and-tools">Tools &amp; Skills</a>.
          </p>

          <SectionHeading id="can-i-use-it-offline" level={3}>
            Can I use it offline?
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            No. Your workspace and tools are local, but your assistant needs an internet connection
            to think &mdash; it sends your messages to the AI model provider (Anthropic) to generate
            responses. Without internet, it can&apos;t respond.
          </p>
        </section>

        <hr className="my-10 border-zinc-200" />

        <section id="about-the-assistant-itself">
          <SectionHeading id="about-the-assistant-itself" level={2}>
            About the assistant itself
          </SectionHeading>

          <SectionHeading id="can-i-change-its-name" level={3}>
            Can I change its name?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Yes. Say &ldquo;I want to rename you to [name]&rdquo; or edit IDENTITY.md directly in{" "}
            <code>~/.vellum/workspace/</code>.
          </p>

          <SectionHeading id="can-i-change-its-personality" level={3}>
            Can I change its personality?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Yes. Tell it what you want (&ldquo;be more casual,&rdquo; &ldquo;stop being
            sarcastic&rdquo;) and it will update SOUL.md. You can also edit SOUL.md directly.
            Changes to workspace files take effect on the next conversation. See{" "}
            <a href="/docs/key-concepts/the-workspace">The Workspace</a>.
          </p>

          <SectionHeading id="can-i-change-how-it-looks" level={3}>
            Can I change how it looks?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Yes. Your assistant has a customizable avatar. Say &ldquo;put on a wizard hat&rdquo; or
            &ldquo;change your color to emerald&rdquo; and it will update its appearance. Avatar
            customization is managed through the assistant&apos;s identity and style settings.
          </p>

          <SectionHeading id="what-ai-model-does-it-use" level={3}>
            What AI model does it use?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Anthropic&apos;s Claude by default. The model can be changed in{" "}
            <code>config.json</code> in your workspace.
          </p>

          <SectionHeading id="does-it-have-feelings" level={3}>
            Does it have feelings?
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            No. It&apos;s very good at sounding like it does, though. Don&apos;t let the personality
            fool you. It&apos;s a language model with a good costume.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
