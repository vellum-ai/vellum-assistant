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
            Controls a connected computer or the assistant&apos;s streamed desktop. It observes
            the screen, then clicks, types, scrolls, and drags. Connected computers can provide
            accessibility trees; the assistant desktop uses color screenshots and pixel coordinates.
            Tell the assistant which computer to use.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Connected-computer control is built into supported desktop apps, which request the
            operating-system permissions they need. The assistant desktop is available only when
            the desktop feature is enabled and automatic installation in the Desktop modal has
            finished. It does not require a connected desktop app.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Accessibility (mouse/keyboard control)</li>
            <li>Screen capture (seeing screen content)</li>
            <li>Connected-computer actions follow your existing access and permission settings</li>
            <li>The assistant desktop requires the owner&apos;s conversation; Take control interrupts automation</li>
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
                    &ldquo;Open my browser and go to my bank&apos;s website&rdquo;
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
            <li>The assistant chooses the requested computer explicitly and does not switch machines as a fallback</li>
            <li>Browser and native actions on the assistant desktop share one control session</li>
            <li>Use Allow assistant in the Desktop modal before asking it to resume after taking control</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Accessibility tree + screenshots.</strong> On connected computers, the assistant reads the
              accessibility tree (same API screen readers use) and requests screenshots as needed.
              On its own desktop, each native action returns a fresh color screenshot.
            </li>
            <li>
              <strong>Element-based clicking.</strong> It prefers clicking by element name rather
              than coordinates for reliability.
            </li>
            <li>
              <strong>Session caps.</strong> Sessions are capped at 50 steps with loop detection.
            </li>
            <li>
              <strong>Platform differences.</strong> Dragging, opening apps by name, and AppleScript
              are available on macOS. Windows exposes only actions its desktop helper supports, so
              unsupported tools are not offered to the assistant.
            </li>
            <li>
              <strong>Batched actions on macOS.</strong> When the assistant already knows several
              steps, such as opening a window, typing a URL, and pressing Enter, it can run them
              in one step and look at the screen once afterward. It stops at the first action
              that fails. This needs a desktop app that supports batched actions.
            </li>
            <li>
              <strong>Single-window observations on macOS.</strong> The observe tool accepts
              <code> capture_window_id</code>, a current native CGWindowID, not a browser tab
              or accessibility element ID. It captures only that window and its accessibility
              tree, even behind another app, without secondary windows or a desktop fallback.
              A compatible desktop app must explicitly advertise window-capture support;
              older or unsupported clients are rejected before capture.
            </li>
            <li>
              <strong>Observation-only scope.</strong> Window selection applies to one observe
              call, not the whole session: later click, type, and scroll actions still return
              normal desktop observations. Selection does not focus the window or restrict
              later input to it. Cropped screenshot coordinates are window-relative, not
              full-display coordinates; prefer accessibility element IDs and focus the
              intended window before acting.
            </li>
            <li>
              <strong>Screen visibility.</strong> Be mindful of what&apos;s visible on screen.
              Screenshots are sent to the AI model.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
