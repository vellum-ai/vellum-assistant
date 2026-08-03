"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-it-does", label: "What it does", level: 2 },
  { id: "setup-required", label: "Setup required", level: 2 },
  { id: "permissions", label: "Permissions", level: 2 },
  { id: "common-prompts", label: "Common prompts", level: 2 },
  { id: "amazon-fresh", label: "Amazon Fresh", level: 2 },
  { id: "configuration", label: "Configuration", level: 2 },
  { id: "tips-gotchas", label: "Tips & gotchas", level: 2 },
];

export function SkillsReferenceAmazonContent() {
  return (
    <>
      <DocsContent title="Amazon" breadcrumb="Docs / Skills Reference / Amazon">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Searches, browses, and shops on Amazon and Amazon Fresh for you &mdash; from finding
            products to placing orders &mdash; using your existing Amazon account.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            First-time setup needed. Your assistant uses your Chrome browser session to interact
            with Amazon, so you&apos;ll need to sign in once:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>Make sure Chrome is open with the Vellum extension connected</li>
            <li>
              Say: <em>&ldquo;Order something from Amazon&rdquo;</em> &mdash; your assistant will
              check your session and prompt you to sign in if needed
            </li>
            <li>
              A Chrome window opens to the Amazon login page. Sign in as usual &mdash; your
              assistant detects the login automatically
            </li>
          </ol>
          <p className="mb-0 text-zinc-600">
            After that, your session is saved and reused until it expires. If it does expire,
            your assistant will ask you to sign in again.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Requires the Vellum Chrome extension to be installed and connected</li>
            <li>Uses your existing Amazon account (no separate credentials stored)</li>
            <li>
              Each command runs on your host machine and will ask for permission before executing
            </li>
          </ul>
        </section>

        <section id="common-prompts" className="mt-12">
          <SectionHeading id="common-prompts" level={2}>
            Common prompts
          </SectionHeading>
          <div className="mb-0 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    You say...
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    What happens
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Order a pack of AA batteries from Amazon&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Searches, shows top results with prices, adds your pick to cart, and walks you
                    through checkout
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Find me a blue t-shirt, size large&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Searches, finds matching products, handles size and color variations
                    automatically
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What&apos;s in my Amazon cart?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Shows your current cart with items, quantities, and prices
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Remove the headphones from my cart&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Removes the specified item from your cart
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Check out my Amazon cart&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Shows order summary with totals, asks for confirmation before placing the order
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Search Amazon for a laptop stand under $30&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Searches and filters results by your criteria
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="amazon-fresh" className="mt-12">
          <SectionHeading id="amazon-fresh" level={2}>
            Amazon Fresh
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Amazon Fresh is fully supported for grocery delivery. The flow is the same as regular
            Amazon shopping, with the addition of delivery slot selection.
          </p>
          <div className="mb-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    You say...
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    What happens
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Order milk and eggs from Amazon Fresh&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Searches Fresh, adds items to your Fresh cart, and handles delivery slot
                    selection
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Add strawberries to my Fresh cart&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Searches Fresh for strawberries and adds the best match
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;When can I get a Fresh delivery?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Shows available delivery windows so you can pick one
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-0 text-zinc-600">
            Fresh orders require a delivery slot before checkout. Your assistant will remind you
            to pick one if you haven&apos;t already.
          </p>
        </section>

        <section id="configuration" className="mt-12">
          <SectionHeading id="configuration" level={2}>
            Configuration
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>No manual configuration needed</li>
            <li>Session is captured automatically when you sign into Amazon in Chrome</li>
            <li>
              Supports multiple payment methods &mdash; your assistant can list your saved cards
              and let you choose at checkout
            </li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Your assistant never places orders without asking.</strong> You&apos;ll
              always see a cart summary and total before anything is charged. Explicit confirmation
              is required.
            </li>
            <li>
              <strong>Chrome extension must be connected.</strong> If commands fail with an
              extension error, open Chrome, click the Vellum extension icon, and click Connect.
            </li>
            <li>
              <strong>Sessions expire.</strong> Amazon sessions don&apos;t last forever. If your
              assistant says the session expired, you&apos;ll need to sign in again &mdash; it
              takes about 30 seconds.
            </li>
            <li>
              <strong>Fresh and regular Amazon have separate carts.</strong> Items added to your
              Fresh cart won&apos;t appear in your regular Amazon cart, and vice versa.
            </li>
            <li>
              <strong>Rate limiting.</strong> Amazon may throttle rapid requests. Your assistant
              handles this automatically by spacing out requests, but if you see errors, just wait
              a moment and try again.
            </li>
            <li>
              <strong>Product variations.</strong> For items with sizes, colors, or styles, your
              assistant will show you the available options and let you pick &mdash; or it&apos;ll
              choose the best match if you&apos;ve already specified (e.g.,{" "}
              &ldquo;large blue&rdquo;).
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
