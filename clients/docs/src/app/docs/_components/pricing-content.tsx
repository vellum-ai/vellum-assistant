"use client";

import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { routes } from "@/lib/routes";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "our-pricing-philosophy", label: "Our pricing philosophy", level: 2 },
  { id: "plans", label: "Plans", level: 2 },
  { id: "base-plan", label: "Base", level: 3 },
  { id: "pro-packages", label: "Pro packages", level: 3 },
  { id: "custom-plan", label: "Custom", level: 3 },
  { id: "machine-sizes", label: "Machine sizes", level: 3 },
  { id: "storage", label: "Storage", level: 3 },
  { id: "credit-bundles", label: "Credit bundles", level: 3 },
  { id: "changing-your-plan", label: "Changing your plan", level: 3 },
  { id: "how-pricing-works", label: "How pricing works", level: 2 },
  { id: "vellum-credits", label: "Vellum Credits", level: 2 },
  {
    id: "what-happens-when-credits-run-out",
    label: "What happens when credits run out",
    level: 3,
  },
  { id: "purchasing-credits", label: "Purchasing Credits", level: 2 },
  { id: "how-to-add-credits", label: "How to add credits", level: 3 },
  { id: "auto-reload", label: "Auto-Reload", level: 3 },
  { id: "how-credits-are-spent", label: "How credits are spent", level: 2 },
  { id: "need-help-with-billing", label: "Need help with billing?", level: 2 },
];

interface CollapsibleSectionProps {
  id: string;
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

function CollapsibleSection({
  id,
  label,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const openIfHashMatches = () => {
      const hash = window.location.hash.replace(/^#/, "");
      if (!hash || !detailsRef.current) {return;}
      const section = detailsRef.current.parentElement;
      if (!section) {return;}
      const matchesSelf = section.id === hash;
      const matchesChild =
        section.querySelector(`#${CSS.escape(hash)}`) !== null;
      if (matchesSelf || matchesChild) {
        detailsRef.current.open = true;
        // Re-scroll once content is laid out
        window.setTimeout(() => {
          document
            .getElementById(hash)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 0);
      }
    };

    openIfHashMatches();
    window.addEventListener("hashchange", openIfHashMatches);
    return () => {
      window.removeEventListener("hashchange", openIfHashMatches);
    };
  }, []);

  return (
    <section id={id}>
      <details
        ref={detailsRef}
        open={defaultOpen}
        className="group border-t border-zinc-200"
      >
        <summary className="not-prose flex cursor-pointer list-none items-center justify-between gap-4 py-4 [&::-webkit-details-marker]:hidden">
          <h2 className="m-0 text-left font-['DM_Sans',sans-serif] text-lg font-semibold leading-7 tracking-tight text-zinc-900">
            {label}
          </h2>
          <ChevronDown
            size={18}
            strokeWidth={2}
            className="shrink-0 text-zinc-500 transition-transform duration-200 group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="pb-8">{children}</div>
      </details>
    </section>
  );
}

export function PricingContent() {
  return (
    <>
      <DocsContent title="Pricing" breadcrumb="Docs / Pricing">
        <section id="our-pricing-philosophy">
          <SectionHeading id="our-pricing-philosophy" level={2}>
            Our pricing philosophy
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            We believe your AI costs should be transparent and predictable.
            Vellum passes through model provider costs at cost. We don&apos;t
            charge any margin or markup on token usage. When you spend $1 worth
            of credits on LLM tokens, that full dollar goes to the model
            provider. Our goal is to keep Vellum affordable and aligned with
            your actual usage, not to profit from the AI calls your assistant
            makes.
          </p>
        </section>

        <div className="mt-12 border-b border-zinc-200">
          <CollapsibleSection id="plans" label="Plans">
            {/* Overview */}
            <p className="mb-6 text-zinc-600">
              Vellum has two plans: <strong>Base</strong> (free) and{" "}
              <strong>Pro</strong> (paid). Pro comes in three preset packages
              (Mighty, Super, Ultra) that bundle machine size, storage, and
              monthly credits, or you can build a <strong>Custom</strong>{" "}
              configuration by selecting each component individually.
            </p>

            {/* Base plan */}
            <SectionHeading
              id="base-plan"
              level={3}
              className="scroll-mt-24"
            >
              Base
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Free, forever. Includes everything you need to run an assistant:
            </p>
            <ul className="mb-6 list-disc space-y-1 pl-6 text-zinc-600">
              <li>Small machine size (1 vCPU, 2 GiB RAM)</li>
              <li>6 GiB of persistent storage</li>
              <li>Pay-as-you-go credits (no monthly minimum)</li>
              <li>Managed LLM credentials (Vellum covers the API keys)</li>
            </ul>

            {/* Pro packages */}
            <SectionHeading
              id="pro-packages"
              level={3}
              className="scroll-mt-24"
            >
              Pro packages
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Three preset packages that bundle a machine size, storage tier,
              and monthly credit allowance into a single monthly price. Each
              package is a starting point: you can adjust individual tiers
              afterward, which converts your plan to a Custom configuration.
            </p>
            <div
              id="package-comparison"
              className="not-prose mb-6 overflow-x-auto"
            >
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-zinc-200">
                    <th className="py-3 pr-6 text-left font-semibold text-zinc-900" />
                    <th className="px-6 py-3 text-left font-semibold text-zinc-900">
                      Mighty
                    </th>
                    <th className="px-6 py-3 text-left font-semibold text-zinc-900">
                      Super
                    </th>
                    <th className="px-6 py-3 text-left font-semibold text-zinc-900">
                      Ultra
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-zinc-100">
                    <td className="py-3 pr-6 font-medium text-zinc-700">
                      Price
                    </td>
                    <td className="px-6 py-3 text-zinc-600">$30/mo</td>
                    <td className="px-6 py-3 text-zinc-600">$100/mo</td>
                    <td className="px-6 py-3 text-zinc-600">$200/mo</td>
                  </tr>
                  <tr className="border-b border-zinc-100">
                    <td className="py-3 pr-6 font-medium text-zinc-700">
                      Machine
                    </td>
                    <td className="px-6 py-3 text-zinc-600">
                      Small (1 vCPU, 2 GiB)
                    </td>
                    <td className="px-6 py-3 text-zinc-600">
                      Medium (2.5 vCPU, 5 GiB)
                    </td>
                    <td className="px-6 py-3 text-zinc-600">
                      Large (4 vCPU, 8 GiB)
                    </td>
                  </tr>
                  <tr className="border-b border-zinc-100">
                    <td className="py-3 pr-6 font-medium text-zinc-700">
                      Storage
                    </td>
                    <td className="px-6 py-3 text-zinc-600">10 GiB</td>
                    <td className="px-6 py-3 text-zinc-600">30 GiB</td>
                    <td className="px-6 py-3 text-zinc-600">60 GiB</td>
                  </tr>
                  <tr className="border-b border-zinc-100">
                    <td className="py-3 pr-6 font-medium text-zinc-700">
                      Monthly credits
                    </td>
                    <td className="px-6 py-3 text-zinc-600">$25</td>
                    <td className="px-6 py-3 text-zinc-600">$45</td>
                    <td className="px-6 py-3 text-zinc-600">$115</td>
                  </tr>
                  <tr className="border-b border-zinc-100">
                    <td className="py-3 pr-6 font-medium text-zinc-700">
                      Platform fee
                    </td>
                    <td className="px-6 py-3 text-zinc-400">
                      Not included
                    </td>
                    <td className="px-6 py-3 text-zinc-600">Included</td>
                    <td className="px-6 py-3 text-zinc-600">Included</td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-6 font-medium text-zinc-700">
                      Email &amp; subdomain
                    </td>
                    <td className="px-6 py-3 text-zinc-400">{"\u2014"}</td>
                    <td className="px-6 py-3 text-zinc-600">Included</td>
                    <td className="px-6 py-3 text-zinc-600">Included</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mb-2 text-zinc-600">
              <strong>Mighty</strong> is the entry-level Pro package. You get
              10 GiB of storage and $25 in monthly credits on the standard
              Small machine. The $10/mo platform fee is not included, so there
              is no custom subdomain, static IP, or priority support.
            </p>
            <p className="mb-2 text-zinc-600">
              <strong>Super</strong> steps up to a Medium machine with 30 GiB
              of storage and $45 in monthly credits. The platform fee is
              included, so you get a custom subdomain, static IP, and priority
              support.
            </p>
            <p className="mb-6 text-zinc-600">
              <strong>Ultra</strong> is the most powerful package: a Large
              machine, 60 GiB of storage, and $115 in monthly credits, with the
              platform fee included.
            </p>

            {/* Custom plan */}
            <SectionHeading
              id="custom-plan"
              level={3}
              className="scroll-mt-24"
            >
              Custom
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              Prefer to pick your own components? The Custom plan lets you
              select a machine size, storage tier, and optional credit bundle
              individually. Your monthly total is the sum of:
            </p>
            <ul className="mb-4 list-disc space-y-1 pl-6 text-zinc-600">
              <li>
                <strong>Platform fee</strong> ($10/mo): custom subdomain,
                static IP, priority support
              </li>
              <li>
                <strong>Machine tier</strong>: $35, $60, or $125/mo (Medium,
                Large, or XL)
              </li>
              <li>
                <strong>Storage tier</strong>: $5 to $30/mo (10 to 120 GiB)
              </li>
              <li>
                <strong>Credit bundle</strong> (optional): $10 to $200/mo
              </li>
            </ul>
            <p className="mb-6 text-zinc-600">
              The minimum Custom configuration is $50/mo (Medium machine + 10
              GiB storage, no credit bundle). Credits are still pay-as-you-go
              on top of any bundle you choose. If you start on a package and
              later change any individual tier, your plan automatically becomes
              Custom.
            </p>

            {/* Machine sizes table */}
            <SectionHeading
              id="machine-sizes"
              level={3}
              className="scroll-mt-24"
            >
              Machine sizes
            </SectionHeading>
            <p className="mb-3 text-zinc-600">
              Sets the maximum compute for assistants in your org. The Small
              machine is included with Base and the Mighty package. Medium,
              Large, and XL are available on the Custom plan and the Super and
              Ultra packages. Resizable anytime from the assistant&apos;s
              settings page.
            </p>
            <div className="not-prose mb-10 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-zinc-200">
                    <th className="py-3 pr-6 text-left font-semibold text-zinc-900">
                      Tier
                    </th>
                    <th className="px-6 py-3 text-left font-semibold text-zinc-900">
                      CPU
                    </th>
                    <th className="px-6 py-3 text-left font-semibold text-zinc-900">
                      RAM
                    </th>
                    <th className="px-6 py-3 text-left font-semibold text-zinc-900">
                      Price
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-zinc-100">
                    <td className="py-3 pr-6 font-medium text-zinc-700">
                      Small
                    </td>
                    <td className="px-6 py-3 text-zinc-600">1 vCPU</td>
                    <td className="px-6 py-3 text-zinc-600">2 GiB</td>
                    <td className="px-6 py-3 text-zinc-600">
                      Included (Base, Mighty)
                    </td>
                  </tr>
                  <tr className="border-b border-zinc-100">
                    <td className="py-3 pr-6 font-medium text-zinc-700">
                      Medium
                    </td>
                    <td className="px-6 py-3 text-zinc-600">2.5 vCPU</td>
                    <td className="px-6 py-3 text-zinc-600">5 GiB</td>
                    <td className="px-6 py-3 text-zinc-600">+$35/mo</td>
                  </tr>
                  <tr className="border-b border-zinc-100">
                    <td className="py-3 pr-6 font-medium text-zinc-700">
                      Large
                    </td>
                    <td className="px-6 py-3 text-zinc-600">4 vCPU</td>
                    <td className="px-6 py-3 text-zinc-600">8 GiB</td>
                    <td className="px-6 py-3 text-zinc-600">+$60/mo</td>
                  </tr>
                  <tr>
                    <td className="py-3 pr-6 font-medium text-zinc-700">XL</td>
                    <td className="px-6 py-3 text-zinc-600">4 vCPU</td>
                    <td className="px-6 py-3 text-zinc-600">16 GiB</td>
                    <td className="px-6 py-3 text-zinc-600">+$125/mo</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Storage tiers table */}
            <SectionHeading
              id="storage"
              level={3}
              className="scroll-mt-24"
            >
              Storage
            </SectionHeading>
            <p className="mb-3 text-zinc-600">
              Persistent disk for files, notes, and conversation history.
              Storage grows online, no assistant restart needed. Base includes
              6 GiB. Pro packages and the Custom plan offer the following
              tiers:
            </p>
            <div className="not-prose mb-6 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-zinc-200">
                    <th className="py-3 pr-6 text-left font-semibold text-zinc-900">
                      Size
                    </th>
                    <th className="px-6 py-3 text-left font-semibold text-zinc-900">
                      Price
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { size: "10 GiB", price: "+$5/mo" },
                    { size: "30 GiB", price: "+$10/mo" },
                    { size: "60 GiB", price: "+$15/mo" },
                    { size: "120 GiB", price: "+$30/mo" },
                  ].map(({ size, price }, i, arr) => (
                    <tr
                      key={size}
                      className={
                        i < arr.length - 1 ? "border-b border-zinc-100" : ""
                      }
                    >
                      <td className="py-3 pr-6 font-medium text-zinc-700">
                        {size}
                      </td>
                      <td className="px-6 py-3 text-zinc-600">{price}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mb-10 text-sm text-zinc-500">
              250 GiB and 500 GiB tiers are available only to existing
              subscribers who already have them. New subscriptions and tier
              changes are limited to the tiers listed above.
            </p>

            {/* Credit bundles */}
            <SectionHeading
              id="credit-bundles"
              level={3}
              className="scroll-mt-24"
            >
              Credit bundles
            </SectionHeading>
            <p className="mb-3 text-zinc-600">
              Pro packages include a monthly credit allowance (for example, $25
              with Mighty, $45 with Super). On the Custom plan, you can add an
              optional recurring credit bundle to your subscription:
            </p>
            <div className="not-prose mb-6 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-zinc-200">
                    <th className="py-3 pr-6 text-left font-semibold text-zinc-900">
                      Monthly credits
                    </th>
                    <th className="px-6 py-3 text-left font-semibold text-zinc-900">
                      Price
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { credits: "$10", price: "+$10/mo" },
                    { credits: "$25", price: "+$25/mo" },
                    { credits: "$50", price: "+$50/mo" },
                    { credits: "$100", price: "+$100/mo" },
                    { credits: "$200", price: "+$200/mo" },
                  ].map(({ credits, price }, i, arr) => (
                    <tr
                      key={credits}
                      className={
                        i < arr.length - 1 ? "border-b border-zinc-100" : ""
                      }
                    >
                      <td className="py-3 pr-6 font-medium text-zinc-700">
                        {credits}
                      </td>
                      <td className="px-6 py-3 text-zinc-600">{price}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mb-10 text-zinc-600">
              Credit bundles are charged as a recurring subscription line item.
              They are separate from pay-as-you-go credit top-ups: bundles give
              you a set amount each month, while pay-as-you-go credits let you
              add more anytime. One Vellum Credit equals one US dollar.
            </p>

            {/* Changing your plan */}
            <SectionHeading
              id="changing-your-plan"
              level={3}
              className="scroll-mt-24"
            >
              Changing your plan
            </SectionHeading>
            <p className="mb-2 text-zinc-600">
              All plan changes are in Settings &rarr; Billing.
            </p>
            <ul className="mb-0 list-disc space-y-1 pl-6 text-zinc-600">
              <li>
                <strong>Upgrade to Pro.</strong> Pick a package (Mighty, Super,
                or Ultra) or start with a Custom configuration. Complete Stripe
                Checkout. Active immediately.
              </li>
              <li>
                <strong>Change tiers.</strong> Switch machine, storage, or
                credit tier anytime. Changes are prorated. Modifying any tier on
                a package converts your plan to Custom.
              </li>
              <li>
                <strong>Cancel.</strong> Takes effect at period end. Pro
                features stay active until then.
              </li>
            </ul>
          </CollapsibleSection>

          <CollapsibleSection id="how-pricing-works" label="How pricing works">
            <p className="mb-4 text-zinc-600">
              Vellum uses a prepaid credit balance: usage is deducted from your
              credits as you use the assistant. You can add credits anytime from
              the Billing page via Stripe Checkout. Applicable taxes may be
              added during checkout.
            </p>
            <p className="mb-4 text-zinc-600">
              In the app, your Billing screen shows a{" "}
              <strong>Credit Balance</strong> plus a breakdown of settled and
              pending amounts:
            </p>
            <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                <strong>Credit Balance</strong>: the current amount available
                after pending compute is considered.
              </li>
              <li>
                <strong>Settled Balance</strong>: charges that have already
                settled.
              </li>
              <li>
                <strong>Pending Usage</strong>: estimated in-flight compute that
                may not be fully settled yet.
              </li>
            </ul>
          </CollapsibleSection>

          <CollapsibleSection id="vellum-credits" label="Vellum Credits">
            <p className="mb-4 text-zinc-600">
              The purchase and use of Vellum Credits is governed by Section 6 of
              our{" "}
              <a
                href={routes.docs.legal.termsOfUse}
                className="font-semibold text-emerald-700 underline hover:text-emerald-800"
              >
                Terms of Service
              </a>
              .
            </p>
            <p className="mb-6 text-zinc-600">
              Vellum makes available certain features and functionalities within
              the Services, as designated by Vellum from time to time, that are
              accessible exclusively through the use of prepaid credits
              (&ldquo;Vellum Credits&rdquo;). These designated features and
              functionalities are referred to as &ldquo;Credit-Eligible
              Features.&rdquo; Credit-Eligible Features currently include
              inference, web search, image creation, and paid third-party APIs
              accessed through Vellum&apos;s managed OAuth (for example,
              Twitter). No alternative direct-payment method is available for
              Credit-Eligible Features.
            </p>

            <div className="mt-8">
              <SectionHeading
                id="what-happens-when-credits-run-out"
                level={3}
                className="scroll-mt-24"
              >
                What happens when credits run out
              </SectionHeading>
              <p className="mb-0 text-zinc-600">
                When credits are exhausted, the app will show a
                &ldquo;You&apos;ve run out of credits&rdquo; message with an{" "}
                <strong>Add Credits</strong> action that links you to Billing.
                Assistant actions that require paid usage will pause until
                credits are added. Enabling Auto-Reload is the easiest way to
                avoid hitting this state.
              </p>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            id="purchasing-credits"
            label="Purchasing Credits"
          >
            <p className="mb-6 text-zinc-600">
              You may fund your Vellum Credit balance (&ldquo;Vellum
              Balance&rdquo;) by purchasing Vellum Credits in ten-dollar ($10.00
              USD) increments, up to one hundred dollars ($100.00 USD) per
              top-up, through the payment methods made available in the
              Services, or at such other amounts as determined by Vellum from
              time to time.
            </p>

            <div className="mt-8">
              <SectionHeading
                id="how-to-add-credits"
                level={3}
                className="scroll-mt-24"
              >
                How to add credits
              </SectionHeading>
              <p className="mb-3 text-zinc-600">
                You can add credits from the app&apos;s Billing settings:
              </p>
              <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
                <li>Open Settings and go to the Billing tab.</li>
                <li>
                  Select <strong>Add Credits</strong>. The amount picker offers
                  $10 to $100 in $10 increments.
                </li>
                <li>Complete checkout in your browser via Stripe.</li>
                <li>
                  Return to the app; your Credit Balance updates automatically.
                </li>
              </ol>
              <p className="mb-0 text-zinc-600">
                One Vellum Credit equals one US dollar. So $10 in checkout adds
                10 credits to your balance.
              </p>
            </div>

            <div className="mt-8">
              <SectionHeading
                id="auto-reload"
                level={3}
                className="scroll-mt-24"
              >
                Auto-Reload
              </SectionHeading>
              <p className="mb-4 text-zinc-600">
                If you&apos;d rather not think about manual top-ups,{" "}
                <strong>Auto-Reload</strong> purchases more credits
                automatically whenever your balance drops below a threshold you
                set. Configure it from Settings → Billing.
              </p>
              <p className="mb-3 text-zinc-600">You set three values:</p>
              <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
                <li>
                  <strong>Auto-Reload when balance below</strong> ($1 to $100).
                  When your credit balance dips under this amount, an automatic
                  top-up is triggered. Default is $100.
                </li>
                <li>
                  <strong>Add amount when auto reloading</strong> ($10 to $500).
                  How much is charged each time the threshold trips. Default is
                  $10.
                </li>
                <li>
                  <strong>Monthly spending cap</strong> (optional, $25 to
                  $10,000). A safety net that pauses auto top-ups for the rest
                  of the calendar month once total credit purchases reach this
                  amount. Manual purchases count toward the cap too. Must be at
                  least the top-up amount. Leave empty for no limit.
                </li>
              </ul>
              <p className="mb-3 text-zinc-600">
                Auto-Reload requires a saved payment method, which you can add
                in the Payment Methods section right below the toggle. If
                you&apos;re close to the monthly cap when the threshold trips,
                Auto-Reload only adds the amount remaining before the cap.
              </p>
              <p className="mb-0 text-zinc-600">
                You can disable Auto-Reload anytime; your saved card stays on
                file so you can re-enable it later without re-entering details.
              </p>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            id="how-credits-are-spent"
            label="How credits are spent"
          >
            <p className="mb-4 text-zinc-600">
              Four categories of work consume credits today:{" "}
              <strong>LLM inference</strong> (the biggest line item by far),{" "}
              <strong>web search</strong>, <strong>image generation</strong>,
              and <strong>paid third-party APIs</strong> you reach through
              Vellum&apos;s managed OAuth (for example, Twitter).
            </p>
            <p className="mb-4 text-zinc-600">
              Inference is itself broken into a set of <strong>Actions</strong>{" "}
              you&apos;ll see attributed in your usage dashboard. Here&apos;s
              what each one does:
            </p>

            <p className="mb-2 mt-6 text-zinc-700">
              <strong>Conversation with your assistant</strong>
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                <strong>Main agent.</strong> Your assistant&apos;s response when
                you chat with them. The biggest chunk for most people when
                actively using the app.
              </li>
              <li>
                <strong>Inference.</strong> One-off model calls from skills or
                utilities that don&apos;t fit a more specific category.
              </li>
            </ul>

            <p className="mb-2 mt-6 text-zinc-700">
              <strong>Memory subsystem</strong> (mostly background)
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                <strong>Memory consolidation.</strong> Promoting short-term
                observations into long-term memory pages.
              </li>
              <li>
                <strong>Memory extraction.</strong> Pulling concrete facts,
                preferences, and entities out of a conversation so they can be
                remembered.
              </li>
              <li>
                <strong>Memory retrieval.</strong> Looking up relevant memories
                when you ask a question or start a task.
              </li>
              <li>
                <strong>Recall.</strong> Targeted, deeper memory lookups across
                notes, knowledge base, and past conversations.
              </li>
            </ul>

            <p className="mb-2 mt-6 text-zinc-700">
              <strong>Conversation polish</strong> (background)
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                <strong>Conversation summarization.</strong> Summarizing
                finished or long conversations so your assistant can refer back
                to them efficiently.
              </li>
              <li>
                <strong>Conversation title.</strong> Auto-generating a short
                title for each new conversation.
              </li>
              <li>
                <strong>Conversation starters.</strong> Suggested prompts the
                app surfaces when idle.
              </li>
              <li>
                <strong>Empty-state greeting.</strong> The hello your assistant
                shows when you open the app with no active conversation.
              </li>
              <li>
                <strong>Context compactor.</strong> Shrinking a long
                conversation&apos;s context so it still fits in the model&apos;s
                window without dropping anything important.
              </li>
            </ul>

            <p className="mb-2 mt-6 text-zinc-700">
              <strong>Autonomy</strong> (background)
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                <strong>Heartbeat agent.</strong> Periodic check-ins where your
                assistant reflects, plans, and decides whether anything needs
                your attention.
              </li>
              <li>
                <strong>Filing agent.</strong> Filing notes, decisions, and
                learnings into your personal knowledge base.
              </li>
              <li>
                <strong>Notification decision.</strong> Deciding whether to push
                you a notification or stay quiet.
              </li>
            </ul>

            <p className="mb-2 mt-6 text-zinc-700">
              <strong>Other</strong>
            </p>
            <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                <strong>Unknown Task.</strong> LLM calls that haven&apos;t been
                tagged with a specific subsystem yet. We&apos;re cleaning up the
                remaining attribution gaps.
              </li>
            </ul>

            <p className="mb-0 text-zinc-600">
              A lot of background work is configurable. You can ask your
              assistant to disable or reduce the frequency of
              &ldquo;heartbeats&rdquo; and &ldquo;memory compaction,&rdquo; or
              to use a less expensive model for these actions. We&apos;re
              actively working on making background spend more visible and
              easier to control.
            </p>
          </CollapsibleSection>
        </div>

        <section
          id="need-help-with-billing"
          className="mt-16 rounded-xl border border-zinc-200 bg-zinc-50 px-6 py-5"
        >
          <p className="m-0 text-zinc-600">
            <strong className="font-semibold text-zinc-900">
              Need help with billing?
            </strong>{" "}
            Join our{" "}
            <a
              href="https://www.vellum.ai/community"
              className="font-semibold text-emerald-700 underline hover:text-emerald-800"
            >
              Discord
            </a>
            .
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
