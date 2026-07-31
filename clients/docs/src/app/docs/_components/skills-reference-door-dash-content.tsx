"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-it-does", label: "What it does", level: 2 },
  { id: "setup-required", label: "Setup required", level: 2 },
  { id: "permissions", label: "Permissions", level: 2 },
  { id: "common-prompts", label: "Common prompts", level: 2 },
  { id: "configuration", label: "Configuration", level: 2 },
  { id: "tips-gotchas", label: "Tips & gotchas", level: 2 },
];

export function SkillsReferenceDoorDashContent() {
  return (
    <>
      <DocsContent title="DoorDash" breadcrumb="Docs / Skills Reference / DoorDash">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Orders food, groceries, and convenience items from DoorDash. Yes, your AI assistant
            can literally order you lunch.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-4 text-zinc-600">DoorDash account connection required. Say:</p>
          <blockquote className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Set up DoorDash.&rdquo;
          </blockquote>
          <p className="mb-0 text-zinc-600">
            Your assistant opens a Chrome window to the DoorDash login page. Sign in as
            usual. Your assistant detects the login automatically and captures the
            session. The Chrome window stays open in the background for API requests.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>DoorDash account credentials stored in the vault</li>
            <li>No macOS permissions needed</li>
            <li>Payment uses whatever payment method is on your DoorDash account</li>
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
                  <td className="px-3 py-2">&ldquo;Order me lunch&rdquo;</td>
                  <td className="px-3 py-2">
                    Finds nearby restaurants and walks you through options
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;I want pizza from the closest place&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Searches nearby pizza spots, shows options
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">&ldquo;Order me a coffee&rdquo;</td>
                  <td className="px-3 py-2">
                    Finds nearby coffee shops and helps you order
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Get me groceries: milk, eggs, bread&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Creates a grocery delivery order
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Reorder what I got last time&rdquo;
                  </td>
                  <td className="px-3 py-2">
Not yet supported. Your assistant can search and reorder from the same
                    restaurant instead
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What&apos;s the cheapest Thai food near me?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Searches and sorts by price
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="configuration" className="mt-12">
          <SectionHeading id="configuration" level={2}>
            Configuration
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Delivery address pulled from your location in USER.md</li>
            <li>Payment handled through your DoorDash account settings</li>
            <li>
Tips are set per-order at checkout. Tell your assistant about dietary
              restrictions and it will remember them as a preference for future orders
            </li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>You approve before it charges you.</strong> Your assistant walks you through
              the order and confirms before placing it. It won&apos;t surprise-order $80 of sushi.
            </li>
            <li>
              <strong>Address:</strong> Make sure your assistant knows your address. It pulls from
              your location, but if you want delivery somewhere else, just say so: &ldquo;Order to my
              office at 123 Main St.&rdquo;
            </li>
            <li>
              <strong>Progress tracking:</strong> Your assistant shows a live task progress card
              while the order is being placed, so you can see each step.
            </li>
            <li>
              <strong>Dietary needs:</strong> Tell your assistant about dietary restrictions
              (&ldquo;I&apos;m vegetarian,&rdquo; &ldquo;no shellfish&rdquo;) and it&apos;ll filter options accordingly.
              Save it as a preference so you don&apos;t have to repeat it.
            </li>
            <li>
              <strong>Tipping:</strong> You can specify a tip amount at checkout
              (e.g., &ldquo;add a $5 tip&rdquo;). Your assistant will ask if you don&apos;t
              specify one
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
