"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "overview", label: "Overview", level: 2 },
  { id: "user-hosted-remote", label: "User-Hosted Remote", level: 2 },
  { id: "gcp", label: "GCP", level: 3 },
  { id: "aws", label: "AWS", level: 3 },
  { id: "mac-mini-as-a-server", label: "Mac Mini as a server", level: 3 },
  { id: "the-remote-tradeoff", label: "The remote tradeoff", level: 2 },
  { id: "comparison", label: "Comparison", level: 2 },
];

export function HostingOptionsAdvancedOptionsContent() {
  return (
    <>
      <DocsContent title="Advanced options" breadcrumb="Docs / Hosting options / Advanced options">
        <section id="overview">
          <SectionHeading id="overview" level={2}>
            Overview
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            This page covers the User-Hosted Remote paths: running your
            assistant on cloud infrastructure that you own and manage,
            instead of on Vellum&apos;s. If you want the managed,
            recommended path, see{" "}
            <Link
              href={"/docs/hosting-options/cloud-hosting"}
              className="font-semibold text-emerald-700 underline hover:text-emerald-800"
            >
              Cloud hosting
            </Link>{" "}
            instead.
          </p>
          <p className="mb-0 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            <strong>Status:</strong> User-Hosted Remote (GCP, AWS, Mac
            Mini) is on the roadmap and actively in development.
          </p>
        </section>


        <section id="user-hosted-remote" className="mt-12">
          <SectionHeading id="user-hosted-remote" level={2}>
            User-Hosted Remote
            <span className="ml-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 align-middle text-xs font-medium text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
              Coming soon
            </span>
          </SectionHeading>
          <p className="mb-6 text-stone-600 dark:text-stone-400">
            You provide the infrastructure, Vellum provides the software. Your
            assistant runs on machines you own and control: a cloud VM, a
            dedicated server, or even a Mac Mini at home.
          </p>

          <div id="gcp" className="mb-8">
            <SectionHeading id="gcp" level={3}>
              GCP
            </SectionHeading>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              Deploy your assistant to your own Google Cloud project. You
              manage IAM, networking, and compute. Your data stays in your GCP
              account.
            </p>
            <div className="mb-4 overflow-x-auto rounded-xl border border-stone-200 bg-moss-950 p-4 dark:border-moss-600/50">
              <code className="font-[family-name:var(--font-dm-mono)] text-sm text-stone-100">
                vellum hatch --remote gcp
              </code>
            </div>
            <p className="mb-0 text-stone-600 dark:text-stone-400">
              Best for users or teams already on GCP who want to keep
              everything within their existing cloud setup.
            </p>
          </div>

          <div id="aws" className="mb-8">
            <SectionHeading id="aws" level={3}>
              AWS
            </SectionHeading>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              Deploy to your own AWS account. Same idea as GCP: you own the
              infrastructure, credentials, and data.
            </p>
            <p className="mb-0 text-stone-600 dark:text-stone-400">
              Best for users or organizations standardized on AWS identity,
              networking, and observability.
            </p>
          </div>

          <div id="mac-mini-as-a-server">
            <SectionHeading id="mac-mini-as-a-server" level={3}>
              Mac Mini as a server
            </SectionHeading>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              A dedicated Mac Mini running at home or in an office, with the
              assistant running locally on it (native, Docker, or Apple
              Container). You connect to it from your primary computer through
              the Vellum desktop app.
            </p>
            <p className="mb-0 text-stone-600 dark:text-stone-400">
              This gives you 24/7 availability, full data ownership on
              hardware you physically possess, and Apple Container isolation.
              The tradeoff: your files and data live on the Mac Mini, not your
              daily laptop. Accessing your laptop&apos;s files requires the
              same host_bash tunneling as any remote option.
            </p>
          </div>
        </section>

        <section id="the-remote-tradeoff" className="mt-12">
          <SectionHeading id="the-remote-tradeoff" level={2}>
            The remote tradeoff
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            All remote options (Vellum Cloud and User-Hosted) share the same
            fundamental tradeoff compared to local hosting:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400">
            <li>
              <strong>You gain:</strong> 24/7 availability, better security
              isolation (the assistant is sandboxed away from your personal
              machine), and the ability to run scheduled tasks and respond to
              messages even when your computer is off.
            </li>
            <li>
              <strong>You lose:</strong> Direct access to your local files and
              system. The assistant can&apos;t browse your Mac&apos;s
              filesystem or use computer use natively. It needs to tunnel back
              through host tools, which only work when you&apos;re actively on
              your computer.
            </li>
          </ul>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            We&apos;re building features like host_bash, host browser use, and
            host computer use to bridge this gap. The goal: the assistant can
            still interact with your personal machine when you&apos;re
            available, and do everything else autonomously on its own machine
            when you&apos;re not.
          </p>
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
                    Option
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Managed by
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Data location
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Setup effort
                  </th>
                  <th className="pb-3 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    24/7 available
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Vellum Cloud
                  </td>
                  <td className="py-3 pr-4">Vellum</td>
                  <td className="py-3 pr-4">Vellum&apos;s cloud</td>
                  <td className="py-3 pr-4">Minimal</td>
                  <td className="py-3">Yes</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    GCP
                  </td>
                  <td className="py-3 pr-4">You</td>
                  <td className="py-3 pr-4">Your GCP project</td>
                  <td className="py-3 pr-4">Significant</td>
                  <td className="py-3">Yes</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    AWS
                  </td>
                  <td className="py-3 pr-4">You</td>
                  <td className="py-3 pr-4">Your AWS account</td>
                  <td className="py-3 pr-4">Significant</td>
                  <td className="py-3">Yes</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Mac Mini
                  </td>
                  <td className="py-3 pr-4">You</td>
                  <td className="py-3 pr-4">Your hardware</td>
                  <td className="py-3 pr-4">Moderate</td>
                  <td className="py-3">Yes</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
