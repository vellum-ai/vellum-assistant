"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "first-things-first", label: "First things first", level: 2 },
  { id: "signing-in", label: "Signing in", level: 2 },
  { id: "iphone-app", label: "iPhone app", level: 2 },
  { id: "desktop-app", label: "Desktop app (Mac)", level: 2 },
  { id: "approvals", label: "Approvals", level: 2 },
  { id: "memory", label: "Memory", level: 2 },
  { id: "voice", label: "Voice", level: 2 },
  { id: "channels", label: "Channels", level: 2 },
  { id: "skills-integrations", label: "Skills and integrations", level: 2 },
  { id: "performance", label: "Performance", level: 2 },
  { id: "still-stuck", label: "Still stuck?", level: 2 },
];

const linkClass =
  "font-semibold text-emerald-700 underline hover:text-emerald-800";

export function HelpCommonIssuesContent() {
  return (
    <>
      <DocsContent
        title="Common Issues"
        breadcrumb="Docs / Help / Common Issues"
      >
        <p className="mb-8 text-zinc-600">
          Things that go wrong, and how to unblock yourself. Most fixes
          start with the same move: ask your assistant. It can usually
          tell you what&apos;s broken faster than this page can.
        </p>

        <section id="first-things-first">
          <SectionHeading id="first-things-first" level={2}>
            First things first
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Before you dig into a section below, try this:
          </p>
          <ol className="mb-0 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Ask your assistant directly.</strong> &ldquo;Why
              didn&apos;t that work?&rdquo; or &ldquo;What&apos;s
              wrong with my Gmail connection?&rdquo; It has access to
              its own tools and recent errors and will usually tell
              you exactly what needs fixing.
            </li>
            <li>
              <strong>Refresh.</strong> Reload the web app, restart the
              desktop app, or close and reopen the iPhone app. Most
              transient issues clear here.
            </li>
            <li>
              <strong>Try a different surface.</strong> If the iPhone
              app is acting up, try the web at{" "}
              <a href="https://vellum.ai" className={linkClass}>
                vellum.ai
              </a>
              . If web is acting up, try the iPhone app or desktop. The
              same assistant lives on each surface.
            </li>
          </ol>
        </section>

        <section id="signing-in" className="mt-12">
          <SectionHeading id="signing-in" level={2}>
            Signing in
          </SectionHeading>

          <SectionHeading id="cant-sign-in" level={3}>
            I can&apos;t sign in to the web or iPhone app
          </SectionHeading>
          <ol className="mb-6 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              Make sure you&apos;re using the same email address you
              signed up with.
            </li>
            <li>
              Check your spam folder for the magic link or
              verification email if one was sent.
            </li>
            <li>
              If you have multiple Vellum accounts, sign out fully
              first, then sign in with the right one.
            </li>
          </ol>

          <SectionHeading id="signed-in-different-assistant" level={3}>
            I&apos;m signed in but I&apos;m talking to a different
            assistant than usual
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            You probably have more than one assistant on your account
            (one provisioned in Vellum Cloud, one running on your
            Mac), and the surface you&apos;re on is pointed at a
            different one. Switch which assistant the surface is
            connected to from the app&apos;s settings, or sign out
            and sign back in to the right account.
          </p>
        </section>

        <section id="iphone-app" className="mt-12">
          <SectionHeading id="iphone-app" level={2}>
            iPhone app
          </SectionHeading>

          <SectionHeading id="ios-push-notifications" level={3}>
            Push notifications aren&apos;t arriving
          </SectionHeading>
          <ol className="mb-6 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              In iOS Settings, find Vellum Assistant and confirm
              Notifications are turned on, plus Sounds and Banners.
            </li>
            <li>
              In Focus modes (Do Not Disturb, Sleep, Work), confirm
              Vellum Assistant isn&apos;t silenced.
            </li>
            <li>
              Open the app once. iOS sometimes drops the push token
              if the app hasn&apos;t been opened in a while.
            </li>
            <li>
              If your assistant is asking for an approval and you want
              the prompt to come through as a push, the device needs
              to be online and notifications need to be allowed.
              Otherwise the approval lives in the chat until you open
              the app.
            </li>
          </ol>

          <SectionHeading id="ios-history-missing" level={3}>
            My conversation history isn&apos;t showing up on the
            iPhone
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Pull down to refresh on the conversations list. If
            it&apos;s still empty, confirm you&apos;re signed in to
            the same account you use on the web. History syncs across
            surfaces but only within one account.
          </p>
        </section>

        <section id="desktop-app" className="mt-12">
          <SectionHeading id="desktop-app" level={2}>
            Desktop app (Mac)
          </SectionHeading>

          <SectionHeading id="unidentified-developer" level={3}>
            &ldquo;Vellum can&apos;t be opened because it is from an
            unidentified developer&rdquo;
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Standard macOS Gatekeeper warning. Right-click the app in
            Finder, choose <strong>Open</strong>, then click{" "}
            <strong>Open</strong> again in the dialog. This only
            happens once.
          </p>

          <SectionHeading id="app-wont-launch" level={3}>
            The app won&apos;t launch or crashes on startup
          </SectionHeading>
          <ol className="mb-6 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>Make sure you&apos;re on macOS 14 (Sonoma) or later.</li>
            <li>
              Check the menu bar for the Vellum icon. If it&apos;s
              missing, the assistant isn&apos;t running.
              Relaunch the app.
            </li>
            <li>
              Open Console.app and filter on{" "}
              <code>com.vellum.vellum-assistant</code> for crash
              logs.
            </li>
            <li>
              As a last resort, delete the app and reinstall.
            </li>
          </ol>

          <SectionHeading id="macos-permissions" level={3}>
            &ldquo;Operation not permitted&rdquo; or a feature
            isn&apos;t working
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your Mac is missing a system permission. Open{" "}
            <strong>System Settings &rsaquo; Privacy &amp; Security</strong>{" "}
            and toggle Vellum on for whichever category you need:
          </p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Accessibility</strong> for keyboard and mouse
              control during computer use
            </li>
            <li>
              <strong>Screen Recording</strong> for seeing what&apos;s
              on screen
            </li>
            <li>
              <strong>Microphone</strong> for voice input
            </li>
            <li>
              <strong>Files and folders / Full Disk Access</strong> if
              your assistant is hitting permission errors reading or
              writing local files
            </li>
          </ul>
        </section>

        <section id="approvals" className="mt-12">
          <SectionHeading id="approvals" level={2}>
            Approvals
          </SectionHeading>

          <SectionHeading id="too-many-prompts" level={3}>
            My assistant keeps asking me to approve the same kind of
            thing
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Each individual action gets its own approval by default,
            so reading three files means three prompts. To cut down on
            this:
          </p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              When you approve, choose <strong>Allow &amp; Create
              Rule</strong> to make similar future actions
              auto-approve.
            </li>
            <li>
              In <strong>Settings &rsaquo; Permissions &amp; Privacy</strong>,
              raise your risk tolerance to auto-approve more action
              types.
            </li>
            <li>
              Review and edit your trust rules in the same settings
              area whenever the pattern is too narrow or too wide.
            </li>
          </ul>

          <SectionHeading id="approval-expired" level={3}>
            The approval prompt disappeared before I could click it
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Approval requests expire after about 5 minutes of no
            response. Just tell your assistant &ldquo;try that
            again&rdquo; and it&apos;ll send a new one.
          </p>

          <SectionHeading id="accidentally-denied" level={3}>
            I clicked Deny by accident
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Tell your assistant to retry: &ldquo;go ahead and read
            that file&rdquo; or &ldquo;try sending that email
            again.&rdquo; A new approval prompt will appear.
          </p>
        </section>

        <section id="memory" className="mt-12">
          <SectionHeading id="memory" level={2}>
            Memory
          </SectionHeading>

          <SectionHeading id="forgot-something" level={3}>
            My assistant forgot something I told it
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A few possibilities:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>It wasn&apos;t saved as a memory.</strong>{" "}
              Filler messages get filtered out. For anything you want
              kept, be explicit: &ldquo;Remember this: I prefer
              meetings before noon.&rdquo;
            </li>
            <li>
              <strong>It&apos;s saved but wasn&apos;t recalled this
              turn.</strong> Memories surface based on relevance to
              the current conversation. Ask more specifically:
              &ldquo;What do you remember about Project
              Moonshot?&rdquo;
            </li>
            <li>
              <strong>It aged out.</strong> Memories have lifetimes
              based on type, and ones that don&apos;t come up again
              eventually fade. If something important slipped, just
              tell your assistant again.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            See{" "}
            <Link
              href={"/docs/key-concepts/memory-and-context"}
              className={linkClass}
            >
              Memory &amp; Context
            </Link>{" "}
            for how the system actually works.
          </p>

          <SectionHeading id="remembers-wrong" level={3}>
            My assistant remembers something I want it to forget
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Tell it directly: &ldquo;Forget that I work at Acme&rdquo;
            or &ldquo;Drop everything you remember about that
            project.&rdquo; You can also browse and delete memories
            from the Memories tab in Settings.
          </p>
        </section>

        <section id="voice" className="mt-12">
          <SectionHeading id="voice" level={2}>
            Voice
          </SectionHeading>

          <SectionHeading id="voice-not-picking-up" level={3}>
            Voice input isn&apos;t picking up my speech
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            What to check depends on the surface:
          </p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Web</strong>: confirm your browser has
              microphone permission for vellum.ai. The first time you
              use voice in a browser, you&apos;ll get a permission
              prompt.
            </li>
            <li>
              <strong>iPhone</strong>: confirm Vellum Assistant has
              microphone access in iOS Settings &rsaquo; Privacy
              &amp; Security &rsaquo; Microphone.
            </li>
            <li>
              <strong>Desktop</strong>: confirm Vellum has microphone
              access in System Settings &rsaquo; Privacy &amp;
              Security &rsaquo; Microphone, and that you&apos;re
              holding the activation key long enough (there&apos;s a
              short hold to filter out accidental presses).
            </li>
          </ul>

          <SectionHeading id="voice-transcription" level={3}>
            Voice transcription is inaccurate
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Accuracy depends on the microphone, background noise, and
            accent. Try speaking more slowly, get closer to the mic,
            or use a headset. For tricky proper nouns or critical
            instructions, type instead.
          </p>
        </section>

        <section id="channels" className="mt-12">
          <SectionHeading id="channels" level={2}>
            Channels
          </SectionHeading>

          <SectionHeading id="telegram-not-working" level={3}>
            Telegram bot isn&apos;t responding
          </SectionHeading>
          <ol className="mb-6 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              Confirm the bot is connected. Ask your assistant:
              &ldquo;Is my Telegram bot set up?&rdquo;
            </li>
            <li>
              If you&apos;re running a local install, confirm your Mac
              is on and the assistant is running. Cloud
              installs don&apos;t need this.
            </li>
            <li>
              Try re-registering the webhook: &ldquo;Reconnect
              Telegram.&rdquo;
            </li>
            <li>
              Verify your bot token is still valid in Telegram&apos;s
              BotFather.
            </li>
          </ol>

          <SectionHeading id="slack-not-working" level={3}>
            Slack isn&apos;t responding or keeps disconnecting
          </SectionHeading>
          <ol className="mb-6 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              Slack uses Socket Mode and needs both a Bot Token and
              an App Token. Confirm both are configured.
            </li>
            <li>
              If the connection drops, it usually reconnects on its
              own. If it doesn&apos;t, ask your assistant to
              &ldquo;reconnect Slack.&rdquo;
            </li>
            <li>
              Confirm the Slack app has the right scopes
              (channels:history, chat:write, app_mentions:read at
              minimum).
            </li>
          </ol>

          <SectionHeading id="phone-not-working" level={3}>
            Phone calls aren&apos;t working
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Confirm the phone channel is set up by asking &ldquo;Is
            my phone number working?&rdquo; If you haven&apos;t gone
            through verification, your assistant will walk you
            through claiming a number. If you have, ask it to test
            the connection.
          </p>
        </section>

        <section id="skills-integrations" className="mt-12">
          <SectionHeading id="skills-integrations" level={2}>
            Skills and integrations
          </SectionHeading>

          <SectionHeading id="oauth-failed" level={3}>
            OAuth connection failed (Gmail, Calendar, Slack, etc.)
          </SectionHeading>
          <ol className="mb-6 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>Check your internet connection.</li>
            <li>
              Try the connection again: &ldquo;Reconnect my
              Gmail.&rdquo;
            </li>
            <li>
              Confirm you&apos;re signing in with the right account
              (personal vs work).
            </li>
            <li>
              If you&apos;re on a corporate Google or Slack workspace,
              your IT team may block third-party OAuth. Ask them to
              allow Vellum.
            </li>
          </ol>

          <SectionHeading id="integration-token-expired" level={3}>
            An integration that worked yesterday stopped working today
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            OAuth tokens expire. Tell your assistant to reconnect it
            (&ldquo;Reconnect my Gmail&rdquo;), and it&apos;ll walk
            you through a fresh sign-in.
          </p>

          <SectionHeading id="custom-skill-not-loading" level={3}>
            A custom skill isn&apos;t loading
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Custom skills live in your assistant&apos;s skills
            directory and need a valid <code>SKILL.md</code>. If
            yours isn&apos;t showing up, ask your assistant
            &ldquo;Why isn&apos;t the [skill name] skill
            loading?&rdquo; and it can read the file and tell you
            what&apos;s wrong. For more on building skills, see the{" "}
            <Link
              href={"/docs/getting-started/your-first-skill"}
              className={linkClass}
            >
              Your first skill
            </Link>{" "}
            guide.
          </p>
        </section>

        <section id="performance" className="mt-12">
          <SectionHeading id="performance" level={2}>
            Performance
          </SectionHeading>

          <SectionHeading id="slow-responses" level={3}>
            My assistant is slow to respond
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Response time depends on the model provider, how complex
            the task is, how many tools it has to use, and how long
            the conversation is. Some quick wins:
          </p>
          <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              Start a fresh conversation if the current one has been
              going for a while. Long context slows things down.
            </li>
            <li>
              Confirm your internet connection is healthy. Voice and
              streaming responses are especially sensitive.
            </li>
            <li>
              If a specific provider feels slow, switch your default
              model in <strong>Settings &rsaquo; Models &amp;
              Services</strong>.
            </li>
          </ul>

          <SectionHeading id="computer-use-stuck" level={3}>
            A computer-use session is stuck or repeating itself
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Sessions are capped at 50 steps and your assistant has
            loop detection that pauses if the screen stops changing.
            If something looks off, cancel the session and try again
            with a more specific instruction (&ldquo;click the blue
            Submit button at the bottom right,&rdquo; not just
            &ldquo;submit&rdquo;).
          </p>
        </section>

        <section id="still-stuck" className="mt-12">
          <SectionHeading id="still-stuck" level={2}>
            Still stuck?
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            If your assistant can&apos;t self-diagnose and nothing
            here matches, head to{" "}
            <Link href={"/docs/help/getting-help"} className={linkClass}>
              Getting Help
            </Link>{" "}
            for where to ask. Bring a description of what you tried,
            what surface you were on, and any error message you saw.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
