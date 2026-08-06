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

export function SkillsReferenceWeatherContent() {
  return (
    <>
      <DocsContent title="Weather" breadcrumb="Docs / Skills Reference / Weather">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Gets current conditions and multi-day forecasts for any location in the world.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">None. Works immediately out of the box.</p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <p className="mb-0 text-zinc-600">None. Runs entirely in the sandbox.</p>
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
                  <td className="px-3 py-2">&ldquo;What&apos;s the weather?&rdquo;</td>
                  <td className="px-3 py-2">
                    Current conditions for your saved location
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What&apos;s the weather in Tokyo?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Current conditions for a specific city
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Will it rain tomorrow?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Next-day forecast for your location
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Give me the 7-day forecast&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Extended outlook with temps and conditions
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Should I bring an umbrella?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Practical weather advice
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What&apos;s the weather like in Lisbon in June?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Seasonal/travel weather lookup
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
            <li>
              Your default location is pulled from USER.md (set during onboarding or anytime:
              &ldquo;I&apos;m in New York&rdquo;)
            </li>
            <li>Supports any city worldwide</li>
            <li>Returns temperatures, conditions, humidity, wind, and multi-day outlook</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Auto-location:</strong> If you&apos;ve told your assistant where you live, you
              never need to specify a city for local weather. Just &ldquo;what&apos;s the weather?&rdquo; works.
            </li>
            <li>
              <strong>Visual output:</strong> Weather responses include a styled forecast card with
              icons, hourly breakdown, and multi-day outlook. It&apos;s not just text.
            </li>
            <li>
              <strong>Travel planning:</strong> Ask about weather in a destination city for specific
              dates and your assistant will factor it into suggestions.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
