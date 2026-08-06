"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "overview", label: "Overview", level: 2 },
  { id: "the-flavors", label: "The flavors", level: 2 },
  { id: "native", label: "Native", level: 3 },
  { id: "docker", label: "Docker", level: 3 },
  { id: "apple-container", label: "Apple Container", level: 3 },
  { id: "comparison", label: "Comparison", level: 2 },
  { id: "when-local-is-the-right-choice", label: "When local is the right choice", level: 2 },
  { id: "the-availability-tradeoff", label: "The availability tradeoff", level: 2 },
  { id: "whats-next-for-local", label: "What's next for local", level: 2 },
];

export function HostingOptionsLocalHostingContent() {
  return (
    <>
      <DocsContent title="Local hosting" breadcrumb="Docs / Hosting options / Local hosting">
        <section id="overview">
          <SectionHeading id="overview" level={2}>
            Overview
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Most users should run on{" "}
            <Link
              href="/docs/hosting-options"
              className="font-semibold text-emerald-700 underline hover:text-emerald-800"
            >
              Vellum Cloud
            </Link>
            . If you want local instead, this page is for you.
          </p>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Local hosting means your assistant runs on your Mac. Your data
            stays on your machine, the assistant has direct access to your
            files and tools, and there&apos;s no cloud infrastructure to
            manage. The tradeoff: it&apos;s only available when your computer
            is awake.
          </p>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Today, local hosting uses native (the assistant runs directly
            as a process on your Mac). Docker and Apple Container options are
            on the roadmap and will provide better isolation while keeping
            everything local.
          </p>
        </section>

        <section id="the-flavors" className="mt-12">
          <SectionHeading id="the-flavors" level={2}>
            The flavors
          </SectionHeading>

          <div id="native" className="mb-10">
            <SectionHeading id="native" level={3}>
              Native
              <span className="ml-2 inline-block rounded-full bg-emerald-100 px-2 py-0.5 align-middle text-xs font-medium text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-200">
                Available now
              </span>
            </SectionHeading>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              The assistant runs directly as a process on your Mac. No
              containers, no virtual machines. This is what you get when you
              install Vellum today.
            </p>
            <dl className="mb-0 space-y-3">
              <div className="rounded-xl border border-stone-200 p-4 dark:border-moss-600/50">
                <dt className="mb-1 font-sans font-semibold text-stone-900 dark:text-stone-100">
                  Pros
                </dt>
                <dd className="m-0 text-sm text-stone-600 dark:text-stone-400">
                  Fastest setup, lowest latency, full access to local files and
                  tools, maximum privacy (data never leaves your machine).
                </dd>
              </div>
              <div className="rounded-xl border border-stone-200 p-4 dark:border-moss-600/50">
                <dt className="mb-1 font-sans font-semibold text-stone-900 dark:text-stone-100">
                  Cons
                </dt>
                <dd className="m-0 text-sm text-stone-600 dark:text-stone-400">
                  Least isolated. The assistant is running on your actual
                  system with fewer security boundaries. If something goes
                  wrong, the blast radius includes your machine.
                </dd>
              </div>
            </dl>
          </div>

          <div id="docker" className="mb-10">
            <SectionHeading id="docker" level={3}>
              Docker
              <span className="ml-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 align-middle text-xs font-medium text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
                Coming soon
              </span>
            </SectionHeading>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              The assistant runs inside a Docker container on your Mac. Think
              of it as a computer inside your computer. The assistant has its
              own isolated environment with its own filesystem, and
              it&apos;s walled off from the rest of your system.
            </p>
            <dl className="mb-0 space-y-3">
              <div className="rounded-xl border border-stone-200 p-4 dark:border-moss-600/50">
                <dt className="mb-1 font-sans font-semibold text-stone-900 dark:text-stone-100">
                  Pros
                </dt>
                <dd className="m-0 text-sm text-stone-600 dark:text-stone-400">
                  Better isolation than native, reproducible environment,
                  data stays local.
                </dd>
              </div>
              <div className="rounded-xl border border-stone-200 p-4 dark:border-moss-600/50">
                <dt className="mb-1 font-sans font-semibold text-stone-900 dark:text-stone-100">
                  Cons
                </dt>
                <dd className="m-0 text-sm text-stone-600 dark:text-stone-400">
                  Requires Docker to be installed and running. Slightly more
                  setup than native.
                </dd>
              </div>
            </dl>
          </div>

          <div id="apple-container">
            <SectionHeading id="apple-container" level={3}>
              Apple Container
              <span className="ml-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 align-middle text-xs font-medium text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
                Coming soon
              </span>
            </SectionHeading>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              Similar to Docker, but runs on native Apple virtual machines.
              You get container-level isolation without needing to install
              Docker, plus Apple&apos;s hardware optimizations and native
              security features.
            </p>
            <dl className="mb-0 space-y-3">
              <div className="rounded-xl border border-stone-200 p-4 dark:border-moss-600/50">
                <dt className="mb-1 font-sans font-semibold text-stone-900 dark:text-stone-100">
                  Pros
                </dt>
                <dd className="m-0 text-sm text-stone-600 dark:text-stone-400">
                  No Docker dependency, native Apple security and hardware
                  optimization, strong isolation, data stays local.
                </dd>
              </div>
              <div className="rounded-xl border border-stone-200 p-4 dark:border-moss-600/50">
                <dt className="mb-1 font-sans font-semibold text-stone-900 dark:text-stone-100">
                  Cons
                </dt>
                <dd className="m-0 text-sm text-stone-600 dark:text-stone-400">
                  Requires macOS with Apple silicon. Slightly more setup than
                  native.
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <section id="comparison" className="mt-12">
          <SectionHeading id="comparison" level={2}>
            Comparison
          </SectionHeading>
          <div className="overflow-x-auto">
            <table className="mb-0 w-full text-sm text-stone-600 dark:text-stone-400">
              <thead>
                <tr className="border-b border-stone-200 dark:border-moss-600">
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Flavor
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Isolation
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Setup
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Dependencies
                  </th>
                  <th className="pb-3 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Native
                  </td>
                  <td className="py-3 pr-4">Minimal</td>
                  <td className="py-3 pr-4">Easiest</td>
                  <td className="py-3 pr-4">None</td>
                  <td className="py-3">Available</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Docker
                  </td>
                  <td className="py-3 pr-4">Container</td>
                  <td className="py-3 pr-4">Moderate</td>
                  <td className="py-3 pr-4">Docker Desktop</td>
                  <td className="py-3">Coming soon</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Apple Container
                  </td>
                  <td className="py-3 pr-4">VM</td>
                  <td className="py-3 pr-4">Moderate</td>
                  <td className="py-3 pr-4">macOS + Apple silicon</td>
                  <td className="py-3">Coming soon</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="when-local-is-the-right-choice" className="mt-12">
          <SectionHeading id="when-local-is-the-right-choice" level={2}>
            When local is the right choice
          </SectionHeading>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400">
            <li>You care a lot about data privacy and want nothing leaving your machine.</li>
            <li>You want the assistant to have direct access to your local files, tools, and system.</li>
            <li>You&apos;re developing and iterating quickly and want the fastest feedback loop.</li>
            <li>You prefer keeping runtime data on hardware you physically control.</li>
          </ul>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            If you need 24/7 availability or want the assistant sandboxed away
            from your personal machine, check out{" "}
            <Link
              href="/docs/hosting-options/advanced-options"
              className="font-semibold text-emerald-700 underline hover:text-emerald-800"
            >
              Advanced options
            </Link>{" "}
            for Vellum Cloud and User-Hosted Remote.
          </p>
        </section>

        <section id="the-availability-tradeoff" className="mt-12">
          <SectionHeading id="the-availability-tradeoff" level={2}>
            The availability tradeoff
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            With any local option, the assistant is only available when your
            computer is awake. If your Mac is asleep or shut down, scheduled
            tasks won&apos;t fire and the assistant can&apos;t respond until
            it wakes back up.
          </p>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            For most people using their primary Mac, this means the assistant
            works great during the workday and whenever the computer is active.
            If you need always-on availability without buying dedicated
            hardware, Vellum Cloud is the better fit.
          </p>
        </section>

        <section id="whats-next-for-local" className="mt-12">
          <SectionHeading id="whats-next-for-local" level={2}>
            What&apos;s next for local
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Docker and Apple Container options are in development. Once they
            ship and stabilize, native local may be phased out in favor of
            the containerized options, which offer much better security
            isolation while keeping all the same privacy and access benefits.
          </p>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            If you&apos;re on native today, you won&apos;t need to do
            anything disruptive. Migration paths will be provided when the time
            comes.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
