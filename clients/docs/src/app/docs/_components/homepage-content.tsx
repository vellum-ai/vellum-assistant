"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { routes } from "@/lib/routes";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

function CollapsibleSection({ id, title, defaultOpen = false, children }: { id: string; title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div id={id} className="docs-home-principle mb-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent p-0 text-left"
      >
        <ChevronRight
          size={14}
          className={`shrink-0 text-zinc-400 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        <h3 id={id} className="m-0 p-0 font-['DM_Sans',sans-serif] text-xl font-semibold text-zinc-800">
          {title}
        </h3>
      </button>
      {open && <div className="pl-6 pt-3">{children}</div>}
    </div>
  );
}

const TOC_ITEMS = [
  { id: "built-on-four-principles", label: "Built on four principles", level: 2 },
  { id: "it-is-inviting", label: "It is inviting", level: 3 },
  { id: "it-is-yours", label: "It is yours", level: 3 },
  { id: "it-is-not-you", label: "It is not you", level: 3 },
  { id: "it-needs-to-earn-your-trust", label: "It needs to earn your trust", level: 3 },
  { id: "so-what-can-it-actually-do", label: "So what can it actually do?", level: 2 },
  { id: "get-started-in-5-minutes", label: "Get started in 5 minutes", level: 2 },
  { id: "a-note-about-trust", label: "A note about trust", level: 2 },
  { id: "for-llms-and-coding-agents", label: "For LLMs and coding agents", level: 2 },
  { id: "explore-the-docs", label: "Explore the docs", level: 2 },
];

export function HomepageContent() {
  return (
    <>
      <DocsContent title="Meet Vellum" breadcrumb="Docs / Homepage">
        <section id="meet-vellum">
          <p className="mb-4 text-zinc-600">
            <strong>Your personal AI assistant. For real this time.</strong>
          </p>
          <p className="mb-4 text-zinc-600">
            Not another chatbot in a browser tab. Vellum is a personal AI assistant that lives
            in the secure Vellum Cloud, has its own identity, and actually does things in the
            world. It can have its own email, its own accounts, its own presence, set up in
            minutes, not hours. It works for you, but it isn&apos;t you.
          </p>
          <p className="mb-8 text-zinc-600">
            And the best part? Getting started feels like magic, not homework.
          </p>
          <p className="mb-0 text-zinc-600">
            Curious what we believe, who we&apos;re building for, and what we refuse to
            compromise on?{" "}
            <Link href={"/docs/constitution"} className="underline">
              Read the Vellum Constitution
            </Link>
            .
          </p>
        </section>

        <section id="built-on-four-principles" className="mt-8">
          <SectionHeading id="built-on-four-principles" level={2}>
            Built on four principles.
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Everything we build, every feature we ship, every word on this page comes back to
            these four ideas.
          </p>

          <CollapsibleSection id="it-is-inviting" title="It is inviting." defaultOpen>
            <p className="mb-4 text-zinc-600">
              AI shouldn&apos;t feel like work. Setting up your assistant should feel like meeting
              someone new, not filling out a form.
            </p>
            <p className="mb-3 text-zinc-600">
              <strong>Simple by design.</strong> We don&apos;t dump every feature on you at once.
              Vellum reveals capabilities as they become relevant. You won&apos;t see a permissions
              screen before you&apos;ve even said hello. You won&apos;t configure OAuth scopes
              before you&apos;ve sent your first email. Things show up when they matter, not before.
            </p>
            <p className="mb-0 text-zinc-600">
              <strong>Fun on purpose.</strong> There&apos;s delight baked into this. Watching your
              assistant come to life, picking its name, shaping its personality, seeing it build
              you an app out of thin air. This is supposed to be exciting. If it ever feels like a
              chore, we&apos;ve failed.
            </p>
          </CollapsibleSection>

          <CollapsibleSection id="it-is-yours" title="It is yours.">
            <p className="mb-4 text-zinc-600">
              This isn&apos;t a shared assistant that treats everyone the same. This one is yours,
              and only yours.
            </p>
            <p className="mb-3 text-zinc-600">
              <strong>Controlled by you.</strong> You decide what it can access, what it can do,
              and how it behaves. You shape its personality, set its boundaries, and choose how it
              presents itself to the outside world. Every permission is explicit. Every capability
              is opt-in.
            </p>
            <p className="mb-3 text-zinc-600">
              <strong>It runs in the secure cloud.</strong> Vellum Cloud hosts your assistant
              so it&apos;s always on and reachable from any browser, ready when you are. Your
              workspace, memories, and config are encrypted, exportable, and yours to delete.
              Want to keep everything on your own machine instead? You can self-host Vellum on
              macOS or your own infrastructure.
            </p>
            <p className="mb-3 text-zinc-600">
              <strong>Personalized to you.</strong> It knows your preferences, your context, your
              quirks. It learns how you like your morning briefing, remembers your projects, adapts
              to your communication style. You don&apos;t bend to fit the tool. The tool bends to
              fit you.
            </p>
            <p className="mb-3 text-zinc-600">
              <strong>Open by default.</strong> Vellum is open source. The assistant runtime, the
              skills, the channels, the docs themselves. All of it lives on{" "}
              <a href="https://github.com/vellum-ai/vellum-assistant" target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
              . Read the code, file an issue, or send a PR. We&apos;re building this in public.
            </p>
            <p className="mb-0 text-zinc-600">
              <strong>Private to you.</strong> Your assistant isn&apos;t a shared resource. It&apos;s
              not approachable by others, not accessible to your coworkers, not a team Slack bot.
              It&apos;s your personal assistant. Emphasis on <em>personal</em>.
            </p>
          </CollapsibleSection>

          <CollapsibleSection id="it-is-not-you" title="It is not you.">
            <p className="mb-4 text-zinc-600">
              Your assistant works <em>for</em> you, but it has its own identity. That&apos;s a
              feature, not a bug.
            </p>
            <p className="mb-3 text-zinc-600">
              <strong>Its own identity.</strong> Your assistant can have its own credentials, its
              own email address, even its own GitHub account. When it acts in the world, it acts
              as itself, on your behalf. It doesn&apos;t pretend to be you. It doesn&apos;t hijack
              your accounts. It&apos;s a separate entity that represents your interests.
            </p>
            <p className="mb-3 text-zinc-600">
              <strong>Its own infrastructure.</strong> By default your assistant lives in
              Vellum Cloud, always on, accessible from web, desktop, mobile, voice, and your
              chat channels. If you&apos;d rather run it on your own Mac or your own server,
              you can. Either way, it operates as its own entity, separate from your daily
              workflow.
            </p>
            <p className="mb-0 text-zinc-600">
              <strong>Clear boundaries.</strong> It will never send a message as you without
              explicit permission. It will never blur the line between its actions and yours. When
              your assistant emails someone, they know they&apos;re talking to your assistant, not
              to you.
            </p>
          </CollapsibleSection>

          <CollapsibleSection id="it-needs-to-earn-your-trust" title="It needs to earn your trust.">
            <p className="mb-4 text-zinc-600">
              We don&apos;t ask for trust upfront. We earn it, gradually, through transparency and
              restraint.
            </p>
            <p className="mb-3 text-zinc-600">
              <strong>Graduated access.</strong> Your assistant starts cautious. It doesn&apos;t
              ask for access to your entire filesystem on day one. It begins with low-risk,
              low-impact actions and works its way up as you get comfortable. Big risks on small
              things first. Small risks on big things later.
            </p>
            <p className="mb-3 text-zinc-600">
              <strong>Transparent by default.</strong> Every action your assistant takes is visible
              to you. Every permission it requests comes with an explanation of what and why. No
              black boxes. No &quot;trust us.&quot; <strong>You can see exactly what it&apos;s
              doing and why at any moment.</strong>
            </p>
            <p className="mb-3 text-zinc-600">
              <strong>Scoped permissions.</strong> Access is controlled through token scopes. Your
              assistant only gets the access it needs for the task at hand. You can grant read
              access without write access. You can allow email without allowing file system access.
              The controls are granular and yours to set.
            </p>
            <p className="mb-0 text-zinc-600">
              <strong>Your data stays yours.</strong> Personal details and work information are
              not shared, not mixed, not leaked between contexts. We take the separation seriously
              because your trust depends on it. We&apos;d rather over-communicate about privacy than
              leave you guessing.
            </p>
          </CollapsibleSection>
        </section>

        <section id="so-what-can-it-actually-do" className="mt-12">
          <SectionHeading id="so-what-can-it-actually-do" level={2}>
            So what can it actually do?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Here&apos;s a taste. Not the full list. The &quot;wait, seriously?&quot; list.
          </p>
          <div className="mb-6 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-3 py-2 text-left text-sm font-medium text-zinc-500">
                    You say...
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-medium text-zinc-500">
                    It does...
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2">Start my day</td>
                  <td className="px-3 py-2">
                    Pulls your weather, calendar, and news into a personalized morning briefing.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">Build me a habit tracker</td>
                  <td className="px-3 py-2">
                    Builds a fully interactive web app, right there in the conversation. Not a mockup, a real working app.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">Check my email</td>
                  <td className="px-3 py-2">
                    Connects to your inbox (or its own), reads, triages, and summarizes your messages. Drafts replies too.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">Read this page and summarize it</td>
                  <td className="px-3 py-2">
                    Uses the browser extension to read your open tabs, fill out forms, and act on the page you&apos;re already looking at.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    Hey Bob, what&apos;s on my calendar today? <em>(spoken)</em>
                  </td>
                  <td className="px-3 py-2">
                    Listens, thinks, talks back. Push-to-talk or always-listening, your call.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">Call the dentist and reschedule</td>
                  <td className="px-3 py-2">
                    Makes an actual phone call, on your behalf, with its own voice. Yes, really.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">Post a tweet about today&apos;s launch</td>
                  <td className="px-3 py-2">
                    Drafts and posts to your X account, replies to threads, reads what people said about your last post.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">Post in #general that deploy is done</td>
                  <td className="px-3 py-2">
                    Sends a Slack message, reads channels, summarizes threads, replies, keeps you in the loop.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">Move this Linear ticket to In Progress</td>
                  <td className="px-3 py-2">
                    Updates Linear directly. Creates tickets, assigns owners, moves states.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">Write a blog post about sourdough</td>
                  <td className="px-3 py-2">
                    Opens a document editor, researches the topic, and drafts a full post you can edit and publish.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">Remember that I hate cilantro</td>
                  <td className="px-3 py-2">
                    Saves it to your Personal Knowledge Base. Remembers it next week, next month, forever. Across every conversation.
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">Order me a coffee</td>
                  <td className="px-3 py-2">
                    Opens DoorDash, finds the nearest spot, walks you through the order. Remembers your usual.
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2} className="px-3 py-2 text-xs text-zinc-400">
                    Some skills require one-time setup. Your assistant walks you through it.
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mb-0 text-zinc-600">
            And when it doesn&apos;t know how to do something? <strong>It figures it out.</strong>{" "}
            You can install new skills from a growing library, build your own, or just ask, and
            watch it find a way. The more you use it, the more it can do.
          </p>
        </section>

        <section id="get-started-in-5-minutes" className="mt-12">
          <SectionHeading id="get-started-in-5-minutes" level={2}>
            Get started in 5 minutes.
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Free. No credit card. No 47-step setup wizard.
          </p>
          <ol className="mb-6 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Sign up</strong> at <a href={routes.signup}>vellum.ai</a>. Free, no credit
              card.
            </li>
            <li>
              <strong>Meet your assistant.</strong> It wakes up in your browser and introduces
              itself.
            </li>
            <li>
              <strong>Have a conversation.</strong> Name it, shape its personality, tell it about
              yourself. Or don&apos;t. It&apos;ll figure you out eventually.
            </li>
            <li>
              <strong>Do something useful.</strong> Check the weather. Build an app. Set a
              reminder. Read your files. Once you&apos;re ready, connect your email, order food,
              and more.
            </li>
          </ol>
          <p className="mb-4 text-zinc-600">
            That&apos;s it. No onboarding marathon. No required setup. Just start talking.
          </p>
          <p className="mb-0 text-zinc-600">
            <a href="/docs/getting-started/quick-start">
              <strong>Quick Start Guide →</strong>
            </a>
          </p>
        </section>

        <section id="a-note-about-trust" className="mt-12">
          <SectionHeading id="a-note-about-trust" level={2}>
            A note about trust. (Because we promised transparency.)
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Whether you use Vellum Cloud or run it on your own machine, your assistant{" "}
            <em>can</em> access your files, your tools, your services. That&apos;s what makes
            it powerful. It&apos;s also what makes it worth understanding.
          </p>
          <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Sensitive actions ask permission.</strong> Day-to-day work stays inside a
              sandboxed workspace. Anything that reaches beyond it (host file access, host shell
              commands, sensitive account scopes) shows an Allow or Deny prompt with a risk badge.
              You can adjust your risk tolerance or create trust rules for standing permissions.
              You&apos;re always in control.
            </li>
            <li>
              <strong>Your data is yours.</strong> Your workspace, memories, and config live in
              your private Vellum Cloud account, encrypted and isolated, or on your own machine
              if you self-host. Either way, you can export them, back them up, or delete them
              at any time.
            </li>
            <li>
              <strong>Your prompts reach an AI model.</strong> Your assistant thinks by talking to a
              cloud AI provider. Your messages and context are sent to generate responses. This is
              the trade-off, and we want you to know about it, not discover it later.
            </li>
            <li>
              <strong>You can always say no.</strong> To any permission, any time. It won&apos;t
              retry without asking, won&apos;t find a workaround, won&apos;t guilt-trip you. No
              means no.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            We have a whole section dedicated to this. You should read it.
          </p>
        </section>

        <section id="for-llms-and-coding-agents" className="mt-12">
          <SectionHeading id="for-llms-and-coding-agents" level={2}>
            For LLMs and coding agents.
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Machine-readable entry points to this documentation:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <a href="/docs/llms.txt">
                <code className="text-sm">/docs/llms.txt</code>
              </a>
              : a curated index of every docs page with short descriptions and Markdown mirrors.
            </li>
            <li>
              <a href="https://www.vellum.ai/llms.txt">
                <code className="text-sm">/llms.txt</code>
              </a>
              : a site-wide index for agents, covering the product identity plus
              direct links to key docs pages, leaderboard data, and other
              structured-content Markdown mirrors.
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Both files are plain Markdown and are refreshed with the site deploy.
          </p>
        </section>

        <section id="explore-the-docs" className="mt-12">
          <SectionHeading id="explore-the-docs" level={2}>
            Explore the docs.
          </SectionHeading>
          <div className="docs-nav-cards">
            <a href="/docs/getting-started" className="docs-nav-card">
              <div className="docs-nav-card-content">
                <span className="docs-nav-card-title">Getting Started</span>
                <span className="docs-nav-card-desc">Install, set up, and have your first useful conversation in under 5 minutes.</span>
              </div>
              <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
            </a>
            <a href="/docs/key-concepts" className="docs-nav-card">
              <div className="docs-nav-card-content">
                <span className="docs-nav-card-title">Key Concepts</span>
                <span className="docs-nav-card-desc">How it all fits together: workspace, skills, tools, memory, and channels.</span>
              </div>
              <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
            </a>
            <a href="/docs/skills-reference" className="docs-nav-card">
              <div className="docs-nav-card-content">
                <span className="docs-nav-card-title">Skills Reference</span>
                <span className="docs-nav-card-desc">Everything your assistant can do out of the box, plus how to teach it new tricks.</span>
              </div>
              <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
            </a>
            <a href="/docs/trust-security" className="docs-nav-card">
              <div className="docs-nav-card-content">
                <span className="docs-nav-card-title">Trust &amp; Security</span>
                <span className="docs-nav-card-desc">Our approach to privacy, permissions, and earning your trust.</span>
              </div>
              <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
            </a>
            <a href="/docs/developer-guide" className="docs-nav-card">
              <div className="docs-nav-card-content">
                <span className="docs-nav-card-title">Developer Guide</span>
                <span className="docs-nav-card-desc">Architecture, security model, and how to build on top of Vellum.</span>
              </div>
              <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
            </a>
            <a href="https://www.vellum.ai/roadmap" className="docs-nav-card">
              <div className="docs-nav-card-content">
                <span className="docs-nav-card-title">Roadmap</span>
                <span className="docs-nav-card-desc">What&apos;s shipping soon, what&apos;s next, and what we&apos;re exploring in the open.</span>
              </div>
              <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
            </a>
            <a href="/docs/help" className="docs-nav-card">
              <div className="docs-nav-card-content">
                <span className="docs-nav-card-title">Help</span>
                <span className="docs-nav-card-desc">FAQ, troubleshooting, and where to go when you&apos;re stuck.</span>
              </div>
              <span className="docs-nav-card-arrow" aria-hidden="true">→</span>
            </a>
          </div>
          <p className="mt-8 mb-0 text-zinc-600">
            <em>
              These docs were written by a personal AI assistant about itself. Which is either the
              most efficient way to write product docs, or the beginning of a very specific sci-fi
              movie.
            </em>{" "}
            😏
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
