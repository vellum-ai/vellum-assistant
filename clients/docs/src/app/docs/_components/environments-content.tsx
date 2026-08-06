"use client";

import Image from "next/image";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "overview", label: "Overview", level: 2 },
  { id: "architecture", label: "Architecture", level: 2 },
  { id: "vellum-cloud", label: "Vellum Cloud", level: 2 },
  { id: "local", label: "Local", level: 2 },
  { id: "user-hosted", label: "User Hosted", level: 2 },
  { id: "gcp", label: "GCP", level: 3 },
  { id: "aws", label: "AWS", level: 3 },
  { id: "custom", label: "Custom", level: 3 },
  { id: "choosing-an-environment", label: "Choosing an Environment", level: 2 },
];

export function EnvironmentsContent() {
  return (
    <>
      <DocsContent title="Environments" breadcrumb="Docs / Environments">
        <section id="overview">
          <SectionHeading id="overview" level={2}>
            Overview
          </SectionHeading>
          <p className="mb-6 text-stone-600 dark:text-stone-400">
            An environment determines where your assistant runs. By default,
            assistants run in <strong>Vellum Cloud</strong>, our managed
            platform, so you can sign up and go without managing any
            infrastructure. If you&apos;d rather host the runtime yourself, you
            can run it locally on your Mac or deploy it to your own GCP, AWS, or
            custom Linux host. The environment you select affects latency,
            availability, resource limits, and how much control you have over
            the underlying infrastructure.
          </p>
          <p className="mb-6 text-stone-600 dark:text-stone-400">
            For self-hosted runtimes, you can specify the environment during
            hatch using the{" "}
            <code className="rounded bg-stone-100 px-1.5 py-0.5 font-[family-name:var(--font-dm-mono)] text-sm dark:bg-moss-700">
              --remote
            </code>{" "}
            flag:
          </p>
          <div className="mb-6 overflow-x-auto rounded-xl border border-stone-200 bg-moss-950 p-4 dark:border-moss-600/50">
            <code className="font-[family-name:var(--font-dm-mono)] text-sm text-stone-100">
              vellum hatch --remote &lt;local | gcp | aws | custom&gt;
            </code>
          </div>
        </section>

        <section id="architecture" className="mt-12">
          <SectionHeading id="architecture" level={2}>
            Architecture
          </SectionHeading>
          <p className="mb-6 text-stone-600 dark:text-stone-400">
            The following diagram shows how the different environments relate to
            channels and external providers:
          </p>
          <div className="mb-8 overflow-x-auto rounded-xl border border-stone-200 bg-white p-4 dark:border-moss-600/50 dark:bg-moss-700">
            <Image
              src="/docs/architecture-diagram.webp"
              alt="Architecture diagram showing the relationship between channels, environments, and external providers"
              width={1200}
              height={800}
              unoptimized
              className="w-full rounded-lg"
            />
          </div>
        </section>

        <section id="vellum-cloud" className="mt-12">
          <SectionHeading id="vellum-cloud" level={2}>
            Vellum Cloud (recommended)
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Run your assistant on Vellum&apos;s managed platform. No cloud
            accounts or server management required, just sign up and go.
          </p>
          <p className="mb-6 text-stone-600 dark:text-stone-400">
            Vellum handles provisioning, upgrades, scaling, and infrastructure
            so you can focus on using your assistant. Managed assistants use
            Anthropic (Claude) as the default provider, billing is handled
            through your Vellum account, and your workspace is encrypted and
            isolated to you.
          </p>
          <dl className="mb-6 space-y-3">
            <div className="rounded-xl border border-stone-200 p-4 transition-colors hover:border-stone-300 dark:border-moss-600/50 dark:hover:border-moss-600">
              <dt className="mb-1 font-sans font-semibold text-stone-900 dark:text-stone-100">
                Pros
              </dt>
              <dd className="m-0 text-sm text-stone-600 dark:text-stone-400">
                Zero setup, always-on, automatic upgrades, no infrastructure to
                manage. Reachable from web, desktop, mobile, voice, and chat
                channels.
              </dd>
            </div>
            <div className="rounded-xl border border-stone-200 p-4 transition-colors hover:border-stone-300 dark:border-moss-600/50 dark:hover:border-moss-600">
              <dt className="mb-1 font-sans font-semibold text-stone-900 dark:text-stone-100">
                Cons
              </dt>
              <dd className="m-0 text-sm text-stone-600 dark:text-stone-400">
                No direct access to local files or tools on your machine without
                the desktop app. Provider selection is managed by Vellum.
              </dd>
            </div>
          </dl>
        </section>

        <section id="local" className="mt-12">
          <SectionHeading id="local" level={2}>
            Local
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Run the assistant runtime on the same machine as the desktop app.
            Useful for development, testing, and privacy-sensitive use cases
            where you want everything on hardware you own.
          </p>
          <div className="mb-4 overflow-x-auto rounded-xl border border-stone-200 bg-moss-950 p-4 dark:border-moss-600/50">
            <code className="font-[family-name:var(--font-dm-mono)] text-sm text-stone-100">
              vellum hatch
            </code>
          </div>
          <p className="mb-6 text-stone-600 dark:text-stone-400">
            When running locally, the assistant daemon and gateway both start on
            your machine. Latency is low and your assistant has direct access to
            local files and tools.
          </p>
          <dl className="mb-6 space-y-3">
            <div className="rounded-xl border border-stone-200 p-4 transition-colors hover:border-stone-300 dark:border-moss-600/50 dark:hover:border-moss-600">
              <dt className="mb-1 font-sans font-semibold text-stone-900 dark:text-stone-100">
                Pros
              </dt>
              <dd className="m-0 text-sm text-stone-600 dark:text-stone-400">
                Low latency, full access to local files and tools, runs entirely
                on your hardware.
              </dd>
            </div>
            <div className="rounded-xl border border-stone-200 p-4 transition-colors hover:border-stone-300 dark:border-moss-600/50 dark:hover:border-moss-600">
              <dt className="mb-1 font-sans font-semibold text-stone-900 dark:text-stone-100">
                Cons
              </dt>
              <dd className="m-0 text-sm text-stone-600 dark:text-stone-400">
                Tied to your machine being on. Uses local compute resources.
              </dd>
            </div>
          </dl>
        </section>

        <section id="user-hosted" className="mt-12">
          <SectionHeading id="user-hosted" level={2}>
            User Hosted
          </SectionHeading>
          <p className="mb-6 text-stone-600 dark:text-stone-400">
            Run the assistant on infrastructure you control. This is useful when
            you need the assistant to stay running independently of your local
            machine, when you need more compute resources, or when you have
            specific compliance requirements. Three hosting options are
            supported:
          </p>

          <div id="gcp" className="mb-8">
            <SectionHeading id="gcp" level={3}>
              GCP
            </SectionHeading>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              Provisions a Google Cloud Compute Engine VM and bootstraps the
              assistant runtime on it.
            </p>
            <div className="mb-4 overflow-x-auto rounded-xl border border-stone-200 bg-moss-950 p-4 dark:border-moss-600/50">
              <code className="font-[family-name:var(--font-dm-mono)] text-sm text-stone-100">
                vellum hatch --remote gcp
              </code>
            </div>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              Requires{" "}
              <code className="rounded bg-stone-100 px-1.5 py-0.5 font-[family-name:var(--font-dm-mono)] text-sm dark:bg-moss-700">
                gcloud
              </code>{" "}
              authentication and the{" "}
              <code className="rounded bg-stone-100 px-1.5 py-0.5 font-[family-name:var(--font-dm-mono)] text-sm dark:bg-moss-700">
                GCP_PROJECT
              </code>{" "}
              and{" "}
              <code className="rounded bg-stone-100 px-1.5 py-0.5 font-[family-name:var(--font-dm-mono)] text-sm dark:bg-moss-700">
                GCP_DEFAULT_ZONE
              </code>{" "}
              environment variables.
            </p>
          </div>

          <div id="aws" className="mb-8">
            <SectionHeading id="aws" level={3}>
              AWS
            </SectionHeading>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              Provisions an AWS EC2 instance and bootstraps the assistant
              runtime on it.
            </p>
            <div className="mb-4 overflow-x-auto rounded-xl border border-stone-200 bg-moss-950 p-4 dark:border-moss-600/50">
              <code className="font-[family-name:var(--font-dm-mono)] text-sm text-stone-100">
                vellum hatch --remote aws
              </code>
            </div>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              Requires AWS credentials configured via the standard AWS CLI
              authentication flow.
            </p>
          </div>

          <div id="custom">
            <SectionHeading id="custom" level={3}>
              Custom
            </SectionHeading>
            <p className="mb-4 text-stone-600 dark:text-stone-400">
              Deploy the assistant to any machine you can SSH into. Set the{" "}
              <code className="rounded bg-stone-100 px-1.5 py-0.5 font-[family-name:var(--font-dm-mono)] text-sm dark:bg-moss-700">
                VELLUM_CUSTOM_HOST
              </code>{" "}
              environment variable to your target host.
            </p>
            <div className="mb-4 overflow-x-auto rounded-xl border border-stone-200 bg-moss-950 p-4 dark:border-moss-600/50">
              <code className="font-[family-name:var(--font-dm-mono)] text-sm text-stone-100">
                VELLUM_CUSTOM_HOST=user@hostname vellum hatch --remote custom
              </code>
            </div>
            <p className="mb-6 text-stone-600 dark:text-stone-400">
              This option gives you full flexibility. Use any Linux machine
              (on-premises, a VPS, or a VM from any cloud provider) as the
              assistant&apos;s runtime environment.
            </p>
          </div>
        </section>

        <section id="choosing-an-environment" className="mt-12">
          <SectionHeading id="choosing-an-environment" level={2}>
            Choosing an Environment
          </SectionHeading>
          <div className="overflow-x-auto">
            <table className="mb-6 w-full text-sm text-stone-600 dark:text-stone-400">
              <thead>
                <tr className="border-b border-stone-200 dark:border-moss-600">
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Environment
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Best For
                  </th>
                  <th className="pb-3 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Requires
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Vellum Cloud
                  </td>
                  <td className="py-3 pr-4">
                    Most users. Zero-ops managed hosting, always-on, accessible from anywhere.
                  </td>
                  <td className="py-3">Vellum account</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Local
                  </td>
                  <td className="py-3 pr-4">
                    Personal use, development, testing, privacy-sensitive workflows
                  </td>
                  <td className="py-3">Desktop app, vellum CLI</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    GCP
                  </td>
                  <td className="py-3 pr-4">
                    Always-on assistant on your own infrastructure
                  </td>
                  <td className="py-3">GCP account, gcloud CLI</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    AWS
                  </td>
                  <td className="py-3 pr-4">
                    Always-on assistant, AWS-native teams
                  </td>
                  <td className="py-3">AWS account, AWS CLI</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Custom
                  </td>
                  <td className="py-3 pr-4">
                    On-premises, custom infra, any SSH host
                  </td>
                  <td className="py-3">SSH access to target machine</td>
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
