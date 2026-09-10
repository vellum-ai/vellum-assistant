"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "overview", label: "Overview", level: 2 },
  { id: "how-it-works", label: "How a purchase works", level: 2 },
  { id: "connecting", label: "Connecting your Link account", level: 2 },
  { id: "safeguards", label: "What keeps you in control", level: 2 },
  { id: "credential-types", label: "Cards and payment tokens", level: 2 },
  { id: "examples", label: "Example prompts", level: 2 },
  { id: "troubleshooting", label: "Troubleshooting", level: 2 },
];

const LINK_CLASS =
  "text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300";

export function AgenticPaymentsContent() {
  return (
    <>
      <DocsContent
        title="Agentic Payments"
        breadcrumb="Docs / Key Concepts / Agentic Payments"
        eyebrow="Key Concepts"
        subtitle="How your assistant pays for things on your behalf through your Link account, with every purchase capped at an amount you approve."
      >
        {/* ------------------------------------------------------------------ */}
        {/* Overview                                                             */}
        {/* ------------------------------------------------------------------ */}
        <section id="overview">
          <SectionHeading id="overview" level={2}>
            Overview
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Your assistant can buy things for you. It does this through{" "}
            <Link href="https://stripe.com/payments/link" className={LINK_CLASS}>
              Link
            </Link>
            , Stripe&apos;s wallet, rather than with a card number you paste into
            chat. You connect your Link account once. When a task calls for a
            purchase, your assistant sends you a spend request naming the
            merchant, the amount, and what the money is for. You approve it in
            the Link app, Link issues a single-use virtual card for that amount,
            and your assistant completes the checkout. Your saved cards stay in
            Link. The assistant never sees them.
          </p>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            This is what lets your assistant finish a task end to end: order
            supplies, renew a subscription, pay for an API call, or book
            something, without stopping to hand a checkout page back to you.
            You set the amount, and you approve every purchase. Link describes
            the agent side of this on its{" "}
            <Link href="https://link.com/agents" className={LINK_CLASS}>
              Link for agents
            </Link>{" "}
            page.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* How a purchase works                                                 */}
        {/* ------------------------------------------------------------------ */}
        <section id="how-it-works" className="mt-12">
          <SectionHeading id="how-it-works" level={2}>
            How a purchase works
          </SectionHeading>
          <ol className="mb-4 list-decimal space-y-3 pl-6 text-stone-600 dark:text-stone-400 marker:text-stone-400 dark:marker:text-stone-500">
            <li>
              <strong>You ask.</strong> For example, &ldquo;Order a replacement
              laptop charger, up to $60.&rdquo; The amount you name is the most
              your assistant will request.
            </li>
            <li>
              <strong>Your assistant drafts a spend request.</strong> It names
              the merchant, the amount, and a plain-language description of what
              it is buying and why. The description is written for you to read
              at approval time.
            </li>
            <li>
              <strong>You approve in the Link app.</strong> Link notifies you.
              The request shows your assistant&apos;s name, the merchant, the
              amount, and the description. You have ten minutes to approve or
              decline. Nothing is charged until you approve.
            </li>
            <li>
              <strong>Link issues a single-use credential.</strong> For an
              ordinary online store, that is a virtual Visa or Mastercard for
              the approved amount. For a merchant that accepts agent payments
              directly, it is a shared payment token.
            </li>
            <li>
              <strong>Your assistant checks out.</strong> It fills the card into
              the merchant&apos;s checkout with its browser, or sends the token to
              the merchant&apos;s payment endpoint, then reports back with the
              confirmation.
            </li>
            <li>
              <strong>The purchase lands in your Link history</strong>, labeled
              with your assistant&apos;s name, so you can review it later
              alongside everything else you have paid for with Link.
            </li>
          </ol>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            If your assistant runs into a checkout page during some other task,
            it routes the payment through Link the same way instead of handing
            you the link to finish yourself.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Connecting                                                           */}
        {/* ------------------------------------------------------------------ */}
        <section id="connecting" className="mt-12">
          <SectionHeading id="connecting" level={2}>
            Connecting your Link account
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            You need two things first: a Link account with at least one saved
            payment method, and the Link app on your phone, which is where you
            approve requests. You can add a payment method at{" "}
            <Link href="https://app.link.com/wallet" className={LINK_CLASS}>
              app.link.com/wallet
            </Link>
            .
          </p>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            The fastest way to connect is to ask your assistant:
          </p>
          <div className="mb-4 overflow-x-auto rounded-lg bg-stone-100 px-4 py-3 dark:bg-moss-900/50">
            <code className="text-sm text-stone-800 dark:text-stone-200">
              &ldquo;Connect my Link wallet&rdquo;
            </code>
          </div>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            A connect card appears in the conversation. Sign in to Link, grant
            access, and you are done. You can also connect through Settings:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-stone-600 dark:text-stone-400 marker:text-stone-400 dark:marker:text-stone-500">
            <li>
              Open <strong>Settings</strong> in your Vellum app.
            </li>
            <li>
              Navigate to the <strong>Integrations</strong> tab.
            </li>
            <li>
              Find <strong>Link by Stripe</strong> and click{" "}
              <strong>Connect</strong>.
            </li>
            <li>Sign in to Link in the window that opens and grant access.</li>
          </ol>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            The connection asks Link for two permissions: create single-use
            cards and payment tokens against your wallet, and read your wallet
            profile (name, email, and phone). It cannot read your saved card
            numbers.
          </p>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            The connection runs through Vellum&apos;s managed OAuth, so it needs
            an assistant that is connected to the Vellum platform. If yours is
            not, your assistant falls back to Link&apos;s own device login: it
            shows you a link and a short phrase, and you approve the connection
            in the Link app. Purchases work the same way either way.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Safeguards                                                           */}
        {/* ------------------------------------------------------------------ */}
        <section id="safeguards" className="mt-12">
          <SectionHeading id="safeguards" level={2}>
            What keeps you in control
          </SectionHeading>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400 marker:text-stone-400 dark:marker:text-stone-500">
            <li>
              <strong>Approval before every purchase.</strong> No card or token
              is issued until you approve that specific request in the Link
              app. Decline it and nothing happens.
            </li>
            <li>
              <strong>An amount you set.</strong> Each credential is issued for
              the approved amount. Link caps a single spend request at $500, so
              anything larger has to be split or handled by you.
            </li>
            <li>
              <strong>Single-use credentials.</strong> A card or token covers
              one checkout. If the checkout fails, the credential is spent and
              your assistant has to send you a new request. Approved credentials
              expire twelve hours after the request is created.
            </li>
            <li>
              <strong>Your real cards stay in Link.</strong> Your assistant
              never sees your saved card numbers. The Link connection itself
              lives in your assistant&apos;s credential vault and is attached to
              requests at the transport layer, like every other OAuth
              integration, so neither the model nor the shell holds a Link
              token.
            </li>
            <li>
              <strong>A description you can read.</strong> Every request
              carries a description of what is being bought and why. If it does
              not match what you asked for, decline it.
            </li>
            <li>
              <strong>Real money only when you say so.</strong> Your assistant
              starts in Link&apos;s test mode, which produces approvals and test
              cards that never charge your payment method. It moves to live
              payments only after you explicitly tell it to spend real money,
              and it asks first when it is unsure.
            </li>
            <li>
              <strong>Review and revoke.</strong> Purchase history in Link lists
              every agent purchase with its status, payment method, and the
              assistant that made it. Disconnect Link from Settings, or by
              asking your assistant, and the stored connection is removed
              immediately. You can also revoke access from your Link account.
            </li>
          </ul>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            For how connections are stored and what the assistant can and
            cannot reach, see{" "}
            <Link
              href="/docs/key-concepts/oauth-integrations"
              className={LINK_CLASS}
            >
              OAuth Integrations
            </Link>{" "}
            and{" "}
            <Link
              href="/docs/trust-security/the-permissions-model"
              className={LINK_CLASS}
            >
              The Permissions Model
            </Link>
            .
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Credential types                                                     */}
        {/* ------------------------------------------------------------------ */}
        <section id="credential-types" className="mt-12">
          <SectionHeading id="credential-types" level={2}>
            Cards and payment tokens
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Link issues one of two credentials for an approved request. You do
            not choose between them. Your assistant picks based on what the
            merchant supports, and both go through the same approval.
          </p>
          <div className="overflow-x-auto">
            <table className="mb-4 w-full text-sm text-stone-600 dark:text-stone-400">
              <thead>
                <tr className="border-b border-stone-200 dark:border-moss-600">
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    Credential
                  </th>
                  <th className="pb-3 pr-4 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    When it is used
                  </th>
                  <th className="pb-3 text-left font-sans font-semibold text-stone-900 dark:text-stone-100">
                    How your assistant pays
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50 dark:[&>tr:nth-child(even)]:bg-moss-900/30">
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Single-use virtual card
                  </td>
                  <td className="py-3 pr-4">
                    Ordinary online checkouts that take a Visa or Mastercard
                  </td>
                  <td className="py-3">
                    Fills the card into the checkout form with its browser, or
                    tokenizes it for a merchant&apos;s payment API
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-stone-900 dark:text-stone-100">
                    Shared payment token
                  </td>
                  <td className="py-3 pr-4">
                    Merchants and APIs that accept agent payments directly
                    (HTTP 402 and the Machine Payments Protocol)
                  </td>
                  <td className="py-3">
                    Sends the token with the request. No checkout form is
                    involved.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Either way the credential is good for one purchase. Card details are
            written to a file the checkout reads from and are never repeated in
            the conversation.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Example prompts                                                      */}
        {/* ------------------------------------------------------------------ */}
        <section id="examples" className="mt-12">
          <SectionHeading id="examples" level={2}>
            Example prompts
          </SectionHeading>
          <div className="mb-3 overflow-x-auto rounded-lg bg-stone-100 px-4 py-3 dark:bg-moss-900/50">
            <code className="text-sm text-stone-800 dark:text-stone-200">
              &ldquo;Order two boxes of printer paper from our usual supplier,
              up to $45&rdquo;
            </code>
          </div>
          <div className="mb-3 overflow-x-auto rounded-lg bg-stone-100 px-4 py-3 dark:bg-moss-900/50">
            <code className="text-sm text-stone-800 dark:text-stone-200">
              &ldquo;Pay for the report from that API. Real money is fine, cap
              it at $10&rdquo;
            </code>
          </div>
          <div className="mb-3 overflow-x-auto rounded-lg bg-stone-100 px-4 py-3 dark:bg-moss-900/50">
            <code className="text-sm text-stone-800 dark:text-stone-200">
              &ldquo;Cancel the spend request you just sent me&rdquo;
            </code>
          </div>
          <div className="mb-4 overflow-x-auto rounded-lg bg-stone-100 px-4 py-3 dark:bg-moss-900/50">
            <code className="text-sm text-stone-800 dark:text-stone-200">
              &ldquo;Disconnect my Link wallet&rdquo;
            </code>
          </div>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Naming a ceiling in the request keeps the approval quick: your
            assistant will not ask for more than you said, and the Link app
            shows you exactly what it asked for.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Troubleshooting                                                      */}
        {/* ------------------------------------------------------------------ */}
        <section id="troubleshooting" className="mt-12">
          <SectionHeading id="troubleshooting" level={2}>
            Troubleshooting
          </SectionHeading>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-stone-600 dark:text-stone-400 marker:text-stone-400 dark:marker:text-stone-500">
            <li>
              <strong>The request expired:</strong> You have ten minutes to
              approve. If it lapses, ask your assistant to send the request
              again.
            </li>
            <li>
              <strong>No payment method:</strong> Link needs at least one saved
              card or bank account. Add one at{" "}
              <Link href="https://app.link.com/wallet" className={LINK_CLASS}>
                app.link.com/wallet
              </Link>{" "}
              and retry.
            </li>
            <li>
              <strong>The checkout failed after you approved:</strong> The
              credential is single-use, so your assistant will send a fresh
              request. Check your Link purchase history before approving again
              to confirm the first attempt did not go through.
            </li>
            <li>
              <strong>The amount is over $500:</strong> That is Link&apos;s
              per-request cap. Split the purchase into smaller requests, or
              complete that one yourself.
            </li>
            <li>
              <strong>Your assistant handed you a checkout link instead of
              paying:</strong>{" "}
              Link is not connected. Connect it and ask again.
            </li>
            <li>
              <strong>Link says the connection needs attention:</strong>{" "}
              Reconnect from Settings or by asking your assistant to reconnect
              Link. Existing approvals are unaffected.
            </li>
          </ul>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            For more detailed troubleshooting steps, see the{" "}
            <Link href="/docs/help/common-issues" className={LINK_CLASS}>
              Common Issues
            </Link>{" "}
            page.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
