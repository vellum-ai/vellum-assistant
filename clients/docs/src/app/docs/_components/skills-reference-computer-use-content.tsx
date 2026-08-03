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

export function SkillsReferenceComputerUseContent() {
  return (
    <>
      <DocsContent title="Computer Use" breadcrumb="Docs / Skills Reference / Computer Use">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Controls your Mac directly &mdash; observes the screen via accessibility APIs and
            screenshots, clicks, types, scrolls, drags, opens apps, and runs AppleScript. Your
            assistant&apos;s hands and eyes on your desktop.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            None (built into the macOS app). Requires macOS system permissions.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Accessibility (mouse/keyboard control)</li>
            <li>Screen Recording (seeing screen content)</li>
            <li>Each action is prompted individually for approval</li>
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
                    &ldquo;Open Safari and go to my bank&apos;s website&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Opens app and navigates
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Click the Submit button&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Clicks a specific UI element
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Fill out this form with my info&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Types into form fields
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Take a screenshot of what&apos;s on screen&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Captures current screen state
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Switch to Slack and check my DMs&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Navigates between apps
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Scroll down to the pricing section&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Scrolls within an app
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
            <li>No configuration needed</li>
            <li>Step limit of 50 actions per session</li>
            <li>
              Each action requires approval unless you create trust rules via the Allow button
            </li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Accessibility tree + screenshots.</strong> The assistant reads the
              accessibility tree (same API screen readers use) AND takes screenshots for a complete
              picture.
            </li>
            <li>
              <strong>Element-based clicking.</strong> It prefers clicking by element name rather
              than coordinates for reliability.
            </li>
            <li>
              <strong>Session caps.</strong> Sessions are capped at 50 steps with loop detection.
            </li>
            <li>
              <strong>macOS only.</strong> Computer use is macOS only &mdash; not available on other channels.
            </li>
            <li>
              <strong>Screen visibility.</strong> Be mindful of what&apos;s visible on screen
              &mdash; screenshots are sent to the AI model.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
