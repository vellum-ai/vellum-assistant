"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "overview", label: "Overview", level: 2 },
  { id: "before-you-start", label: "Before you start", level: 2 },
  { id: "set-up-a-tunnel", label: "Set up a tunnel provider", level: 2 },
  { id: "ngrok", label: "ngrok", level: 3 },
  { id: "tailscale", label: "Tailscale", level: 3 },
  { id: "start-the-tunnel", label: "Start the tunnel", level: 2 },
  { id: "pair-your-device", label: "Pair your device", level: 2 },
  { id: "other-ways-to-pair", label: "Other ways to pair", level: 3 },
  { id: "revoke-a-device", label: "Revoke a device", level: 2 },
  { id: "troubleshooting", label: "Troubleshooting", level: 2 },
];

const linkClass = "font-semibold text-emerald-700 underline hover:text-emerald-800";
const paraClass = "mb-4 text-stone-600 dark:text-stone-400";
const lastParaClass = "mb-0 text-stone-600 dark:text-stone-400";
const bulletClass = "mb-6 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400";
const codeClass =
  "rounded bg-stone-100 px-1.5 py-0.5 font-[family-name:var(--font-dm-mono)] text-sm dark:bg-moss-700";
const blockClass = "mb-6 overflow-x-auto";
const preClass = "font-[family-name:var(--font-dm-mono)] text-sm";
const uiClass = "font-medium text-stone-900 dark:text-stone-100";
const pillClass =
  "ml-2 inline-block rounded-full bg-emerald-100 px-2 py-0.5 align-middle text-xs font-medium text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-200";
const cardClass = "rounded-xl border border-stone-200 p-4 dark:border-moss-600/50";
const cardTitleClass =
  "mb-1 font-sans font-semibold text-stone-900 dark:text-stone-100";
const cardBodyClass = "m-0 text-sm text-stone-600 dark:text-stone-400";

export function HostingOptionsPairADeviceContent() {
  return (
    <>
      <DocsContent
        title="Pair a device"
        breadcrumb="Docs / Hosting options / Pair a device"
        subtitle="Reach a self-hosted assistant from your phone or another computer."
      >
        <section id="overview">
          <SectionHeading id="overview" level={2}>
            Overview
          </SectionHeading>
          <p className={paraClass}>
            A self-hosted assistant runs on one computer, and by default that is
            the only place you can talk to it. Two pieces of setup let another
            device reach it:
          </p>
          <ul className={bulletClass}>
            <li>
              <strong>A tunnel</strong>{" "}
              gives your assistant an https address other devices can reach. You
              start it once and leave it running.
            </li>
            <li>
              <strong>A pairing</strong>{" "}
              gives one device permission to use that address. Every device is
              paired and revoked separately.
            </li>
          </ul>
          <p className="mb-0 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
            <strong>You connect through your own address, not through
            vellum.ai.</strong>{" "}
            The tunnel URL serves the Vellum web app pointed at your assistant,
            so a paired device talks straight to your machine. Conversations
            never pass through Vellum&apos;s servers.
          </p>
        </section>

        <section id="before-you-start" className="mt-12">
          <SectionHeading id="before-you-start" level={2}>
            Before you start
          </SectionHeading>
          <p className={paraClass}>On the computer that hosts your assistant:</p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400">
            <li>
              <strong>Make sure it&apos;s running.</strong>{" "}
              <code className={codeClass}>vellum ps</code> to check,{" "}
              <code className={codeClass}>vellum wake</code> to start it. No
              assistant yet? See{" "}
              <Link href="/docs/hosting-options/local-hosting" className={linkClass}>
                Local hosting
              </Link>
              .
            </li>
            <li>
              <strong>Install nginx.</strong>{" "}
              Tunnels run through it, and Vellum starts it for you but
              won&apos;t install it:{" "}
              <code className={codeClass}>brew install nginx</code> on macOS,{" "}
              <code className={codeClass}>sudo apt install nginx</code> on Linux.
            </li>
          </ul>
        </section>

        <section id="set-up-a-tunnel" className="mt-12">
          <SectionHeading id="set-up-a-tunnel" level={2}>
            Set up a tunnel provider
          </SectionHeading>
          <p className={paraClass}>
            <strong>ngrok</strong>{" "}
            gives your assistant a public https address, so any phone or laptop
            can open it with nothing installed on that device.
          </p>
          <p className={paraClass}>
            <strong>Tailscale</strong>{" "}
            keeps the address off the public internet, which is more private but
            costs you two things. Every device you pair needs Tailscale
            installed and signed in, phone included. And a Tailscale address
            can&apos;t receive inbound webhooks, so channels like Telegram and
            Twilio still need a public tunnel alongside it. Vellum leaves an
            existing one in place and uses the Tailscale address for pairing
            only.
          </p>
          <p className={lastParaClass}>
            Either way, a device still has to be paired and approved before it
            can do anything. If you&apos;re not sure, start with ngrok.
          </p>

          <div id="ngrok" className="mt-10">
            <SectionHeading id="ngrok" level={3}>
              ngrok
              <span className={pillClass}>Recommended</span>
            </SectionHeading>
            <ol className="mb-0 list-decimal space-y-3 pl-6 text-stone-600 dark:text-stone-400">
              <li>
                <strong>Create a free account</strong> at{" "}
                <Link href="https://ngrok.com" className={linkClass}>
                  ngrok.com
                </Link>
                .
              </li>
              <li>
                <strong>Install the agent.</strong>{" "}
                <code className={codeClass}>brew install ngrok/ngrok/ngrok</code>{" "}
                on macOS, or{" "}
                <code className={codeClass}>sudo snap install ngrok</code> on
                Linux.
              </li>
              <li>
                <strong>Add your authtoken</strong>{" "}
                from the <span className={uiClass}>Your Authtoken</span> page in
                the dashboard:
                <div className="mt-3 overflow-x-auto">
                  <pre className={preClass}>
<code>{`ngrok config add-authtoken <your-token>`}</code>
                  </pre>
                </div>
              </li>
              <li>
                <strong>Claim a static domain.</strong>{" "}
                Optional, but it saves re-pairing later. Without one, ngrok
                issues a new URL each time the tunnel restarts, and paired
                devices keep pointing at the old one. A reboot, a Ctrl+C, or a{" "}
                <code className={codeClass}>vellum wake</code>{" "}
                all restart it.
                Note the domain you pick; you&apos;ll pass it to Vellum in the
                next section.
              </li>
            </ol>
          </div>

          <div id="tailscale" className="mt-10">
            <SectionHeading id="tailscale" level={3}>
              Tailscale
            </SectionHeading>
            <ol className="mb-0 list-decimal space-y-3 pl-6 text-stone-600 dark:text-stone-400">
              <li>
                <strong>Create a free account</strong> at{" "}
                <Link href="https://tailscale.com" className={linkClass}>
                  tailscale.com
                </Link>
                , install it on the host machine (
                <code className={codeClass}>brew install tailscale</code>), and
                run <code className={codeClass}>tailscale up</code> to sign in.
                Your machine gets a stable name like{" "}
                <code className={codeClass}>your-mac.tailnet-name.ts.net</code>.
              </li>
              <li>
                <strong>Turn on HTTPS certificates.</strong>{" "}
                In the admin console, open <span className={uiClass}>DNS</span>{" "}
                and enable{" "}
                <span className={uiClass}>HTTPS Certificates</span> (see{" "}
                <Link
                  href="https://tailscale.com/kb/1153/enabling-https"
                  className={linkClass}
                >
                  Enabling HTTPS
                </Link>{" "}
                in the Tailscale docs). Without it the tunnel command fails,
                though it prints Tailscale&apos;s own link to switch them on.
              </li>
              <li>
                <strong>Install Tailscale on every device you want to pair.</strong>{" "}
                Miss this and the pairing link simply won&apos;t open: the
                address doesn&apos;t resolve outside your network.
              </li>
            </ol>
          </div>
        </section>

        <section id="start-the-tunnel" className="mt-12">
          <SectionHeading id="start-the-tunnel" level={2}>
            Start the tunnel
          </SectionHeading>
          <p className={paraClass}>
            Run this on the computer hosting the assistant. For ngrok, pass the
            domain you reserved:
          </p>
          <div className={blockClass}>
            <pre className={preClass}>
<code>{`vellum tunnel --provider ngrok --domain your-assistant.ngrok.app`}</code>
            </pre>
          </div>
          <p className={paraClass}>For Tailscale:</p>
          <div className={blockClass}>
            <pre className={preClass}>
<code>{`vellum tunnel --provider tailscale`}</code>
            </pre>
          </div>
          <p className={paraClass}>
            Either way the command prints{" "}
            <code className={codeClass}>Tunnel established:</code> followed by
            the address your devices will use, and saves that address so the
            pairing steps below fill it in for you.
          </p>
          <p className={paraClass}>
            The tunnel has to stay up for as long as you want remote access. To
            keep it running without leaving a terminal open, add{" "}
            <code className={codeClass}>-d</code>:
          </p>
          <div className={blockClass}>
            <pre className={preClass}>
<code>{`vellum tunnel --provider ngrok -d`}</code>
            </pre>
          </div>
          <p className={lastParaClass}>
            It waits for the tunnel to come up, then prints the address, where
            it is logging, and the{" "}
            <code className={codeClass}>kill</code>{" "}
            command that stops it again.
            Vellum remembers your ngrok domain after the first run, which is why
            this one doesn&apos;t repeat{" "}
            <code className={codeClass}>--domain</code>.
          </p>
        </section>

        <section id="pair-your-device" className="mt-12">
          <SectionHeading id="pair-your-device" level={2}>
            Pair your device
          </SectionHeading>
          <p className={paraClass}>
            The last step is to pair the device, and the easiest route is the
            desktop app on the host computer. Open Vellum there and go to{" "}
            <span className={uiClass}>
              Settings &rarr; General &rarr; Pair a device
            </span>
            .
          </p>
          <p className={paraClass}>
            The card confirms your tunnel is reachable, then{" "}
            <span className={uiClass}>Generate pairing QR</span> gives you a QR
            code to scan from a phone and a link you can open on another
            computer. Codes work once and expire after 10 minutes, so generate a
            fresh one per device.
          </p>
          <p className={paraClass}>
            Scanning finishes the job. The host approved that code when it
            created it, so there is nothing to confirm and no code to type. With
            the Vellum mobile app installed, the page offers to hand the pairing
            over to it.
          </p>
          <p className={lastParaClass}>
            The card only appears on the machine running the assistant, since
            being there is what authorizes the pairing. Once paired, a device
            stays paired across reloads, though only while the tunnel is up:
            pairing grants access to your tunnel address, not a separate route
            in.
          </p>

          <div id="other-ways-to-pair" className="mt-10">
            <SectionHeading id="other-ways-to-pair" level={3}>
              Other ways to pair
            </SectionHeading>
            <p className={paraClass}>
              <strong>Start from the device itself.</strong>{" "}
              Open your{" "}
              <a href="#start-the-tunnel" className={linkClass}>
                tunnel address
              </a>{" "}
              on the device. It lands on the pairing page, shows a short code,
              and waits. On the host, the request appears under{" "}
              <span className={uiClass}>Pairing requests</span>{" "}
              in the same card. Check that code against the device&apos;s screen
              before approving: the match is what proves the request came from
              your device. Or approve from a shell with{" "}
              <code className={codeClass}>vellum pair --web-approve &lt;code&gt;</code>
              .
            </p>
            <p className={paraClass}>
              <strong>No desktop app on the host.</strong>{" "}
              If you hatched the assistant over SSH on a VPS, pair from the CLI
              instead. It prints a pairing link and the same link as a QR
              code, using the address from{" "}
              <code className={codeClass}>vellum tunnel</code>:
            </p>
            <div className={blockClass}>
              <pre className={preClass}>
<code>{`vellum pair`}</code>
              </pre>
            </div>
            <p className={paraClass}>
              Add <code className={codeClass}>--app</code> to point the QR at
              the mobile app instead of a browser,{" "}
              <code className={codeClass}>--url</code> to pair against a
              different address,{" "}
              <code className={codeClass}>--label</code> to name the pairing, or{" "}
              <code className={codeClass}>--json</code> for scripting.
            </p>
            <p className={paraClass}>
              <strong>Pair another computer.</strong>{" "}
              A second machine with the{" "}
              <code className={codeClass}>vellum</code> CLI joins with that
              link rather than a browser, and{" "}
              <code className={codeClass}>vellum pair</code> prints the exact
              command to run under it. The link already carries an approved
              code, so the import finishes right away and registers the
              assistant locally for{" "}
              <code className={codeClass}>vellum client</code>:
            </p>
            <div className={blockClass}>
              <pre className={preClass}>
<code>{`vellum connect import "https://your-assistant.ngrok.app/assistant/pair#device_code=..."`}</code>
              </pre>
            </div>
            <p className={paraClass}>
              No link handy? Give it your tunnel address on its own. That
              machine mints its own code, prints it, and waits for you to
              approve it on the host, from{" "}
              <span className={uiClass}>Pairing requests</span> in the card or
              with{" "}
              <code className={codeClass}>vellum pair --web-approve &lt;code&gt;</code>:
            </p>
            <div className={blockClass}>
              <pre className={preClass}>
<code>{`vellum connect import https://your-assistant.ngrok.app`}</code>
              </pre>
            </div>
            <p className={lastParaClass}>
              Ctrl+C on the waiting machine stops only that side. The request
              stays in the host&apos;s pending list, still approvable, until it
              expires 10 minutes after it was minted. To withdraw it sooner,
              click <span className={uiClass}>Deny</span> beside it in the{" "}
              <span className={uiClass}>Pair a device</span> card; the CLI has
              no deny command.
            </p>
          </div>

        </section>

        <section id="revoke-a-device" className="mt-12">
          <SectionHeading id="revoke-a-device" level={2}>
            Revoke a device
          </SectionHeading>
          <p className={paraClass}>
            Revoking happens on the host. To see what&apos;s paired to it:
          </p>
          <div className={blockClass}>
            <pre className={preClass}>
<code>{`vellum devices`}</code>
            </pre>
          </div>
          <p className={paraClass}>
            Each row shows the device type, pairing and last-used dates, and a
            hashed id. That hash is what you revoke with:
          </p>
          <div className={blockClass}>
            <pre className={preClass}>
<code>{`vellum devices revoke 3f9a1c...`}</code>
            </pre>
          </div>
          <p className={paraClass}>
            Confirm the prompt (<code className={codeClass}>--yes</code> skips
            it) and that device loses access immediately; it has to be paired
            again to return. The row marked{" "}
            <span className={uiClass}>This machine</span>{" "}
            is the host&apos;s own
            credential and can&apos;t be revoked.
          </p>
          <p className={paraClass}>
            Two things that look like revoking but aren&apos;t:
          </p>
          <ul className={bulletClass}>
            <li>
              <code className={codeClass}>vellum unpair &lt;name&gt;</code>{" "}
              runs on the paired machine and only forgets the connection there.
              The host still trusts it.
            </li>
            <li>
              Stopping the tunnel cuts everything off at once, but revokes
              nothing: it all reconnects when the tunnel returns.
            </li>
          </ul>
          <p className={lastParaClass}>
            A <span className={uiClass}>Paired devices</span> list with the same
            revoke button is rolling out in the{" "}
            <span className={uiClass}>Pair a device</span> card. Until it reaches
            your build, use the CLI.
          </p>
        </section>

        <section id="troubleshooting" className="mt-12">
          <SectionHeading id="troubleshooting" level={2}>
            Troubleshooting
          </SectionHeading>
          <dl className="mb-0 space-y-3">
            <div className={cardClass}>
              <dt className={cardTitleClass}>
                My phone worked yesterday and can&apos;t connect today
              </dt>
              <dd className={cardBodyClass}>
                The tunnel isn&apos;t running, or the address changed. On ngrok
                without a reserved domain it changes on every restart: reserve
                one, pass it once with{" "}
                <code className={codeClass}>--domain</code>, and pair again.
              </dd>
            </div>
            <div className={cardClass}>
              <dt className={cardTitleClass}>
                I get an ngrok warning page instead of my assistant
              </dt>
              <dd className={cardBodyClass}>
                Expected on the free plan, on a browser&apos;s first visit. Tap
                through it.
              </dd>
            </div>
            <div className={cardClass}>
              <dt className={cardTitleClass}>
                Pairing says it needs a public https address
              </dt>
              <dd className={cardBodyClass}>
                No tunnel is running yet. Vellum won&apos;t build a pairing code
                around a <code className={codeClass}>localhost</code> address,
                which would point the phone back at itself.
              </dd>
            </div>
            <div className={cardClass}>
              <dt className={cardTitleClass}>
                &ldquo;tailscale serve failed&rdquo;
              </dt>
              <dd className={cardBodyClass}>
                Usually HTTPS certificates aren&apos;t enabled for your tailnet;
                the error carries Tailscale&apos;s link to switch them on. If it
                says Tailscale isn&apos;t logged in, run{" "}
                <code className={codeClass}>tailscale up</code>.
              </dd>
            </div>
            <div className={cardClass}>
              <dt className={cardTitleClass}>
                On Tailscale, the other device can&apos;t open the link
              </dt>
              <dd className={cardBodyClass}>
                That device needs Tailscale installed and signed in to the same
                account. Tailscale addresses don&apos;t resolve anywhere else.
              </dd>
            </div>
            <div className={cardClass}>
              <dt className={cardTitleClass}>&ldquo;Pairing expired&rdquo;</dt>
              <dd className={cardBodyClass}>
                Codes last 10 minutes and work once. Generate a fresh one from
                the settings card or with{" "}
                <code className={codeClass}>vellum pair</code>.
              </dd>
            </div>
          </dl>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
