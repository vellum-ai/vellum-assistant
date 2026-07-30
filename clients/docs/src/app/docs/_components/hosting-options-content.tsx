"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "the-three-dimensions", label: "The three dimensions", level: 2 },
  { id: "the-options", label: "The options", level: 2 },
  { id: "vellum-cloud", label: "Vellum Cloud", level: 3 },
  { id: "local", label: "Local", level: 3 },
  { id: "user-hosted-remote", label: "User-Hosted Remote", level: 3 },
  { id: "which-should-i-choose", label: "Which should I choose?", level: 2 },
  { id: "hosting-paths", label: "Explore hosting paths", level: 2 },
];

export function HostingOptionsContent() {
  return (
    <>
      <DocsContent title="Hosting options" breadcrumb="Docs / Hosting options">
        <p className="mb-4 text-stone-600 dark:text-stone-400">
          Your Vellum assistant needs a computer to run on. Which computer, and
          who manages it, is the hosting decision. The right choice depends on
          what matters most to you.
        </p>
        <p className="mb-8 text-stone-600 dark:text-stone-400">
          There are two primary options available today,{" "}
          <strong>Vellum Cloud</strong> (recommended) and <strong>Local</strong>,
          plus advanced self-hosted paths for technical users. This page
          explains all of them so you can make an informed choice.
        </p>

        <section id="the-three-dimensions">
          <SectionHeading id="the-three-dimensions" level={2}>
            The three dimensions
          </SectionHeading>
          <p className="mb-6 text-stone-600 dark:text-stone-400">
            Every hosting option is a tradeoff between three things:
          </p>
          <div className="mb-6 grid gap-4 md:grid-cols-3">
            <div className="rounded-xl border border-stone-200 p-5 dark:border-moss-600/50">
              <h4 className="mb-2 font-sans text-base font-semibold text-stone-900 dark:text-stone-100">
                Ease of use
              </h4>
              <p className="m-0 text-sm text-stone-600 dark:text-stone-400">
                How much setup and maintenance is required? Does Vellum handle
                the infrastructure, or do you?
              </p>
            </div>
            <div className="rounded-xl border border-stone-200 p-5 dark:border-moss-600/50">
              <h4 className="mb-2 font-sans text-base font-semibold text-stone-900 dark:text-stone-100">
                Privacy
              </h4>
              <p className="m-0 text-sm text-stone-600 dark:text-stone-400">
                Where does your data live? Does it pass through Vellum&apos;s
                servers, or does it stay entirely on hardware you control?
              </p>
            </div>
            <div className="rounded-xl border border-stone-200 p-5 dark:border-moss-600/50">
              <h4 className="mb-2 font-sans text-base font-semibold text-stone-900 dark:text-stone-100">
                Security
              </h4>
              <p className="m-0 text-sm text-stone-600 dark:text-stone-400">
                How isolated is the assistant from your personal files and
                system? What&apos;s the blast radius if something goes wrong?
              </p>
            </div>
          </div>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            No single option wins on all three. The more convenient the setup,
            the more you&apos;re trusting someone else with your data. The more
            private the setup, the more you&apos;re managing yourself.
          </p>
        </section>

        <section id="the-options" className="mt-12">
          <SectionHeading id="the-options" level={2}>
            The options
          </SectionHeading>
          <p className="mb-6 text-stone-600 dark:text-stone-400">
            There are two primary hosting options available today, plus advanced
            self-hosted paths for users who want full control.
          </p>

          <div id="vellum-cloud" className="mb-10">
            <SectionHeading id="vellum-cloud" level={3}>
              Vellum Cloud
              <span className="ml-2 inline-block rounded-full bg-emerald-100 px-2 py-0.5 align-middle text-xs font-medium text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-200">
                Recommended
              </span>
            </SectionHeading>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              Your assistant runs entirely on Vellum&apos;s secure
              infrastructure. Ready out of the box. No local setup, no servers
              to manage, no hardware requirements. Just sign in and go.
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400">
              <li>
                <strong>Ease of use:</strong> The best. Minimal setup, Vellum
                handles everything.
              </li>
              <li>
                <strong>Privacy:</strong> Your data lives in your private,
                encrypted Vellum Cloud account. If keeping your data off
                third-party infrastructure is a priority, consider Local
                instead.
              </li>
              <li>
                <strong>Security:</strong> Arguably the most secure option for
                the user. The assistant runs completely sandboxed in
                Vellum&apos;s cloud, not on any of your hardware. If something
                goes wrong, the blast radius is contained to our
                infrastructure, not yours.
              </li>
              <li>
                <strong>Availability:</strong> Always on, 24/7. Your assistant
                is available even when your computer is off or asleep,
                reachable from web, desktop, mobile, voice, and chat channels.
              </li>
            </ul>
          </div>

          <div id="local" className="mb-10">
            <SectionHeading id="local" level={3}>
              Local
            </SectionHeading>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              Your assistant runs on your Mac. Your machine, your data, nothing
              leaves your computer. This is the option for users who want
              maximum privacy and direct access to local files and tools.
            </p>
            <ul className="mb-4 list-disc space-y-4 pl-6 text-stone-600 dark:text-stone-400">
              <li>
                <strong>Native</strong>: The assistant runs directly as a
                process on your Mac. It&apos;s the simplest local setup and
                gives the assistant full access to your system.
              </li>
              <li>
                <strong>Docker</strong>{" "}
                <span className="ml-1 inline-block rounded-full bg-amber-100 px-2 py-0.5 align-middle text-xs font-medium text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
                  Coming soon
                </span>
                . The assistant runs inside a Docker container on your Mac.
                Better isolation than native, but requires Docker to be
                installed and running.
              </li>
              <li>
                <strong>Apple Container</strong>{" "}
                <span className="ml-1 inline-block rounded-full bg-amber-100 px-2 py-0.5 align-middle text-xs font-medium text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
                  Coming soon
                </span>
                . Runs on native Apple virtual machines. No Docker required.
                You get isolation plus Apple&apos;s hardware optimizations and
                native security features.
              </li>
            </ul>
            <p className="mb-0 text-stone-600 dark:text-stone-400">
              All local options keep your data on your machine (great for
              privacy) and give the assistant direct access to your files and
              tools (great for power). The tradeoff: the assistant is only
              available when your computer is awake.
            </p>
          </div>

          <div id="user-hosted-remote">
            <SectionHeading id="user-hosted-remote" level={3}>
              User-Hosted Remote
              <span className="ml-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 align-middle text-xs font-medium text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
                Coming soon
              </span>
            </SectionHeading>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              Your assistant runs on cloud infrastructure that you own and
              manage: your GCP project, your AWS account, or even a Mac Mini
              running at home that you connect to remotely.
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400">
              <li>
                <strong>Ease of use:</strong> The most setup required. You
                manage the infrastructure, credentials, and networking.
              </li>
              <li>
                <strong>Privacy:</strong> Your data stays on your
                infrastructure. Nothing passes through Vellum&apos;s servers.
              </li>
              <li>
                <strong>Security:</strong> You control the isolation level, but
                you also bear the responsibility for it.
              </li>
            </ul>
            <p className="mb-0 text-stone-600 dark:text-stone-400">
              This is the option for technical users who want full control and
              24/7 availability without relying on Vellum&apos;s infrastructure.
            </p>
          </div>
        </section>

        <section id="which-should-i-choose" className="mt-12">
          <SectionHeading id="which-should-i-choose" level={2}>
            Which should I choose?
          </SectionHeading>

          {/* Scatter plot: Ease of Use vs Security & Privacy */}
          <div className="mb-8 max-w-xl">
            <svg
              viewBox="0 0 480 380"
              className="w-full"
              role="img"
              aria-label="Scatter plot comparing hosting options by ease of use and security and privacy"
            >
              {/* Grid lines - horizontal */}
              <line x1="60" y1="95" x2="440" y2="95" stroke="#f4f4f5" strokeWidth="1" />
              <line x1="60" y1="170" x2="440" y2="170" stroke="#f4f4f5" strokeWidth="1" />
              <line x1="60" y1="245" x2="440" y2="245" stroke="#f4f4f5" strokeWidth="1" />

              {/* Grid lines - vertical */}
              <line x1="155" y1="20" x2="155" y2="320" stroke="#f4f4f5" strokeWidth="1" />
              <line x1="250" y1="20" x2="250" y2="320" stroke="#f4f4f5" strokeWidth="1" />
              <line x1="345" y1="20" x2="345" y2="320" stroke="#f4f4f5" strokeWidth="1" />

              {/* Y axis label */}
              <text
                x="18"
                y="170"
                textAnchor="middle"
                fontSize="12"
                fontWeight="600"
                fill="#71717a"
                transform="rotate(-90, 18, 170)"
              >
                Security &amp; Privacy
              </text>

              {/* Y axis ticks */}
              <text x="52" y="318" textAnchor="end" fontSize="10" fill="#a1a1aa">Low</text>
              <text x="52" y="173" textAnchor="end" fontSize="10" fill="#a1a1aa">Med</text>
              <text x="52" y="28" textAnchor="end" fontSize="10" fill="#a1a1aa">High</text>

              {/* X axis label */}
              <text x="250" y="365" textAnchor="middle" fontSize="12" fontWeight="600" fill="#71717a">
                Ease of Use
              </text>

              {/* X axis ticks */}
              <text x="60" y="345" textAnchor="middle" fontSize="10" fill="#a1a1aa">Low</text>
              <text x="250" y="345" textAnchor="middle" fontSize="10" fill="#a1a1aa">Med</text>
              <text x="440" y="345" textAnchor="middle" fontSize="10" fill="#a1a1aa">High</text>

              {/* Dots and labels */}
              <circle cx="410" cy="130" r="8" fill="#10b981" opacity="0.9" />
              <text x="410" y="115" textAnchor="middle" fontSize="11" fontWeight="600" fill="#18181b">
                Vellum Cloud
              </text>

              <circle cx="400" cy="240" r="8" fill="#f59e0b" opacity="0.9" />
              <text x="400" y="260" textAnchor="middle" fontSize="11" fontWeight="600" fill="#18181b">
                Local (native)
              </text>

              <circle cx="270" cy="100" r="8" fill="#8b5cf6" opacity="0.9" />
              <text x="270" y="85" textAnchor="middle" fontSize="11" fontWeight="600" fill="#18181b">
                Local (Docker / Apple)
              </text>

              <circle cx="110" cy="100" r="8" fill="#3b82f6" opacity="0.9" />
              <text x="110" y="85" textAnchor="middle" fontSize="11" fontWeight="600" fill="#18181b">
                User-Hosted Remote
              </text>
            </svg>
          </div>

          <div className="space-y-6">
            <div className="rounded-xl border border-stone-200 p-5 dark:border-moss-600/50">
              <h4 className="mb-2 font-sans text-base font-semibold text-stone-900 dark:text-stone-100">
                Most people: Vellum Cloud
                <span className="ml-2 inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-200">
                  Recommended
                </span>
              </h4>
              <p className="m-0 text-sm text-stone-600 dark:text-stone-400">
                It&apos;s always on, there&apos;s nothing to maintain, you
                don&apos;t need to buy extra hardware, and we&apos;ll continue
                building features (like host computer use) to bridge any
                functional gaps between cloud and local. For the vast majority
                of users, this is the right answer.
              </p>
            </div>
            <div className="rounded-xl border border-stone-200 p-5 dark:border-moss-600/50">
              <h4 className="mb-2 font-sans text-base font-semibold text-stone-900 dark:text-stone-100">
                Privacy-conscious users: Local
              </h4>
              <p className="m-0 text-sm text-stone-600 dark:text-stone-400">
                If keeping your data off third-party servers is a priority,
                local is the way to go. Today that means native. Once
                available, Apple Container on your Mac (or a dedicated Mac
                Mini) will be the best local option, giving you both privacy
                and better isolation.
              </p>
            </div>
            <div className="rounded-xl border border-stone-200 p-5 dark:border-moss-600/50">
              <h4 className="mb-2 font-sans text-base font-semibold text-stone-900 dark:text-stone-100">
                Technical users who want full control: User-Hosted Remote
              </h4>
              <p className="m-0 text-sm text-stone-600 dark:text-stone-400">
                If you want 24/7 availability, full data ownership, and
                you&apos;re comfortable managing cloud infrastructure, deploy
                to your own GCP or AWS account. It&apos;s more work to set up,
                but you get the best of both worlds: always-on and
                self-managed.
              </p>
            </div>
          </div>
        </section>

        <section id="hosting-paths" className="mt-12">
          <SectionHeading id="hosting-paths" level={2}>
            Explore hosting paths
          </SectionHeading>
          <div className="grid gap-4 md:grid-cols-3">
            <Link
              href={"/docs/hosting-options/cloud-hosting"}
              className="rounded-xl border border-stone-200 p-5 no-underline transition-colors hover:border-stone-300 dark:border-moss-600/50 dark:hover:border-moss-600"
            >
              <h3 className="mb-2 font-sans text-lg font-semibold text-stone-900 dark:text-stone-100">
                Cloud hosting
              </h3>
              <p className="m-0 text-sm text-stone-600 dark:text-stone-400">
                Always-on, sandboxed per account, reachable from web,
                desktop, voice, and chat. The recommended path.
              </p>
            </Link>

            <Link
              href={"/docs/hosting-options/local-hosting"}
              className="rounded-xl border border-stone-200 p-5 no-underline transition-colors hover:border-stone-300 dark:border-moss-600/50 dark:hover:border-moss-600"
            >
              <h3 className="mb-2 font-sans text-lg font-semibold text-stone-900 dark:text-stone-100">
                Local hosting
              </h3>
              <p className="m-0 text-sm text-stone-600 dark:text-stone-400">
                Native, Docker, and Apple Container. How local hosting
                works, the flavors, and tradeoffs.
              </p>
            </Link>

            <Link
              href={"/docs/hosting-options/advanced-options"}
              className="rounded-xl border border-stone-200 p-5 no-underline transition-colors hover:border-stone-300 dark:border-moss-600/50 dark:hover:border-moss-600"
            >
              <h3 className="mb-2 font-sans text-lg font-semibold text-stone-900 dark:text-stone-100">
                Advanced options
              </h3>
              <p className="m-0 text-sm text-stone-600 dark:text-stone-400">
                User-Hosted Remote: GCP, AWS, and Mac Mini. For users
                who want 24/7 availability on infrastructure they own.
              </p>
            </Link>
          </div>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
