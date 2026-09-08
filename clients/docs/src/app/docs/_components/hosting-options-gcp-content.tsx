"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { DocsVideo } from "@/app/docs/_components/docs-video";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-you-need", label: "What you need", level: 2 },
  { id: "provision-the-vm", label: "Provision the VM", level: 2 },
  { id: "install-and-hatch", label: "Install and hatch", level: 2 },
  { id: "day-to-day", label: "Day to day", level: 2 },
  { id: "troubleshooting", label: "Troubleshooting", level: 2 },
];

const linkClass = "font-semibold text-emerald-700 underline hover:text-emerald-800";
const paraClass = "mb-4 text-stone-600 dark:text-stone-400";
const lastParaClass = "mb-0 text-stone-600 dark:text-stone-400";
const bulletClass = "mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400";
const codeClass =
  "rounded bg-stone-100 px-1.5 py-0.5 font-[family-name:var(--font-dm-mono)] text-sm dark:bg-moss-700";
const preClass = "font-[family-name:var(--font-dm-mono)] text-sm";
const cardClass = "rounded-xl border border-stone-200 p-4 dark:border-moss-600/50";
const cardTitleClass =
  "mb-1 font-sans font-semibold text-stone-900 dark:text-stone-100";
const cardBodyClass = "m-0 text-sm text-stone-600 dark:text-stone-400";
const stepListClass =
  "mb-0 list-decimal space-y-6 pl-6 text-stone-600 dark:text-stone-400";

export function HostingOptionsGcpContent() {
  return (
    <>
      <DocsContent
        title="GCP"
        breadcrumb="Docs / Hosting options / GCP"
        subtitle="Run your assistant on a Compute Engine VM in your own Google Cloud Platform (GCP) project."
      >
        <p className={paraClass}>
          It keeps your assistant running after you close your laptop, on a
          machine and a disk you own. This is the VPS approach: you create the
          VM, install Vellum on it, and reach it through a tunnel.
        </p>
        <div className="mb-8" />

        <DocsVideo video="gcp-vm-setup" />

        <section id="what-you-need">
          <SectionHeading id="what-you-need" level={2}>
            What you need
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400">
            <li>A GCP project with billing enabled, and the <code className={codeClass}>gcloud</code> CLI.</li>
            <li>
              An API key for the LLM provider of your choice, on hand.
            </li>
            <li>About 15 minutes.</li>
          </ul>
        </section>

        <section id="provision-the-vm" className="mt-12">
          <SectionHeading id="provision-the-vm" level={2}>
            Provision the VM
          </SectionHeading>
          <ol className={stepListClass}>
            <li>
              <strong className="block">Set up gcloud and the project.</strong>{" "}
              Install the CLI from{" "}
              <Link
                href="https://cloud.google.com/sdk/docs/install"
                className={linkClass}
              >
                cloud.google.com/sdk/docs/install
              </Link>
              , then:
              <div className="mt-3 overflow-x-auto">
                <pre className={preClass}>
<code>{`gcloud init
gcloud projects create my-assistant-project
gcloud config set project my-assistant-project
gcloud services enable compute.googleapis.com`}</code>
                </pre>
              </div>
              <p className="mt-3 mb-0">
                Enable billing in the{" "}
                <Link
                  href="https://console.cloud.google.com/billing"
                  className={linkClass}
                >
                  Billing console
                </Link>
                , or Compute Engine won&apos;t start an instance.
              </p>
            </li>

            <li>
              <strong className="block">Create the VM.</strong>{" "}
              <code className={codeClass}>e2-standard-4</code> (4 vCPU, 16 GB) is
              a comfortable default;{" "}
              <code className={codeClass}>e2-standard-2</code> works for light
              use. Pick a zone near you. 20 GB of disk is plenty to start; boot
              disks can be grown later, never shrunk.
              <div className="mt-3 overflow-x-auto">
                <pre className={preClass}>
<code>{`gcloud compute instances create vellum-assistant \\
  --zone=us-central1-a \\
  --machine-type=e2-standard-4 \\
  --boot-disk-size=20GB \\
  --image-family=debian-12 \\
  --image-project=debian-cloud`}</code>
                </pre>
              </div>
              <p className="mt-3 mb-0">
                <strong>Note:</strong>{" "}
                an always-on VM bills continuously, so check Google&apos;s{" "}
                <Link
                  href="https://cloud.google.com/products/calculator"
                  className={linkClass}
                >
                  pricing calculator
                </Link>{" "}
                for what your choices cost per month.
              </p>
            </li>

            <li>
              <strong className="block">SSH in.</strong>{" "}
              Key propagation takes a minute or two after the VM is created, so
              retry if the first attempt is refused.
              <div className="mt-3 overflow-x-auto">
                <pre className={preClass}>
<code>{`gcloud compute ssh vellum-assistant --zone=us-central1-a`}</code>
                </pre>
              </div>
            </li>
          </ol>
        </section>

        <section id="install-and-hatch" className="mt-12">
          <SectionHeading id="install-and-hatch" level={2}>
            Install and hatch
          </SectionHeading>
          <p className={paraClass}>Everything from here runs on the VM.</p>
          <ol className={stepListClass}>
            <li>
              <strong>Install Vellum and its dependencies.</strong>
              <div className="mt-3 overflow-x-auto">
                <pre className={preClass}>
<code>{`# Bun's installer needs curl and unzip
sudo apt-get update
sudo apt-get install -y curl unzip git

# Vellum ships as a Bun package, so Bun needs to be installed
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.11"
source ~/.bashrc

# Install Vellum itself
bun install -g vellum`}</code>
                </pre>
              </div>
            </li>

            <li>
              <strong>Hatch the assistant.</strong>
              <div className="mt-3 overflow-x-auto">
                <pre className={preClass}>
<code>{`vellum hatch`}</code>
                </pre>
              </div>
              <p className="mt-3 mb-0">
                You&apos;ll be asked to pick an LLM provider and enter an
                API key for it. It then starts the assistant and gateway, and
                prints a local runtime URL like{" "}
                <code className={codeClass}>http://127.0.0.1:7830</code>.
              </p>
            </li>

            <li>
              <strong className="block">Talk to it.</strong>{" "}
              Your assistant is alive! Message it interactively from the
              terminal and confirm everything works.
              <div className="mt-3 overflow-x-auto">
                <pre className={preClass}>
<code>{`vellum client`}</code>
                </pre>
              </div>
            </li>

            <li>
              <strong className="block">(Optional) Pair for remote access.</strong>{" "}
              So far the assistant is only reachable via CLI from the VM
              itself. You can set up a tunnel, then pair to it from your phone
              or laptop. To learn more, see{" "}
              <Link href="/docs/hosting-options/pair-a-device" className={linkClass}>
                Pair a device
              </Link>
              .
            </li>
          </ol>
        </section>

        <section id="day-to-day" className="mt-12">
          <SectionHeading id="day-to-day" level={2}>
            Day to day
          </SectionHeading>
          <ul className={bulletClass}>
            <li>
              <code className={codeClass}>vellum ps</code> shows what&apos;s
              running;{" "}
              <code className={codeClass}>vellum wake</code> and{" "}
              <code className={codeClass}>vellum sleep</code> start and stop it,
              keeping the workspace on disk.
            </li>
            <li>
              If you paired any devices,{" "}
              <code className={codeClass}>vellum devices</code> lists them and{" "}
              <code className={codeClass}>vellum devices revoke &lt;id&gt;</code>{" "}
              cuts one off.
            </li>
          </ul>
          <p className={paraClass}>
            Nothing restarts on its own after a VM reboot. Bring the assistant
            back with{" "}
            <code className={codeClass}>vellum wake</code>, and restart your
            tunnel too if you set one up.
          </p>
          <p className={lastParaClass}>
            Stopping the instance keeps the disk and everything on it. Deleting
            it takes the workspace too, unless you kept the disk.
          </p>
        </section>

        <section id="troubleshooting" className="mt-12">
          <SectionHeading id="troubleshooting" level={2}>
            Troubleshooting
          </SectionHeading>
          <dl className="mb-0 space-y-3">
            <div className={cardClass}>
              <dt className={cardTitleClass}>Creating the VM fails</dt>
              <dd className={cardBodyClass}>
                New projects start with low CPU quotas, and a zone can run out
                of a machine type. A quota error means you need more CPUs in
                that region; a zone-capacity error means the type isn&apos;t
                available there right now. Retry in another zone (
                <code className={codeClass}>--zone=us-central1-b</code>) or with
                a smaller <code className={codeClass}>--machine-type</code>.
              </dd>
            </div>
            <div className={cardClass}>
              <dt className={cardTitleClass}>
                SSH won&apos;t connect, or the installs on the VM fail
              </dt>
              <dd className={cardBodyClass}>
                Some organizations block external IP addresses by policy. A VM
                without one is reachable through Identity-Aware Proxy, by adding{" "}
                <code className={codeClass}>--tunnel-through-iap</code> to{" "}
                <code className={codeClass}>gcloud compute ssh</code>, but it
                also has no outbound internet until someone configures Cloud
                NAT, which is what makes{" "}
                <code className={codeClass}>apt-get</code> and the Bun installer
                hang or fail.
              </dd>
            </div>
            <div className={cardClass}>
              <dt className={cardTitleClass}>
                <code className={codeClass}>vellum</code>: command not found
              </dt>
              <dd className={cardBodyClass}>
                Bun&apos;s install directory isn&apos;t on your{" "}
                <code className={codeClass}>PATH</code> in this shell. Open a new
                SSH session, or run{" "}
                <code className={codeClass}>source ~/.bashrc</code>.
              </dd>
            </div>
          </dl>
        </section>

      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
