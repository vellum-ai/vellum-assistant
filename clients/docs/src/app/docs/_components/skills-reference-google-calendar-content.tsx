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

export function SkillsReferenceGoogleCalendarContent() {
  return (
    <>
      <DocsContent
        title="Google Calendar"
        breadcrumb="Docs / Skills Reference / Google Calendar"
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Connects to your Google Calendar so your assistant can view your schedule, create
            events, check availability, and help manage your time.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-4 text-zinc-600">OAuth2 connection to your Google account. Say:</p>
          <blockquote className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Connect my Google Calendar.&rdquo;
          </blockquote>
          <p className="mb-0 text-zinc-600">
            Your assistant opens a Google authorization page. Log in, grant access, done.
            One-time setup.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Requires OAuth2 authorization with Google</li>
            <li>
              Calendar read/write access (scoped to calendar only, not your entire Google account)
            </li>
            <li>No macOS permissions needed</li>
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
                  <td className="px-3 py-2">&ldquo;What&apos;s on my calendar today?&rdquo;</td>
                  <td className="px-3 py-2">
                    Shows today&apos;s events in a clean summary
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Am I free Thursday afternoon?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Checks your availability for the time range
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Schedule a meeting with the design team Tuesday at 2pm&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Creates a new calendar event
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">&ldquo;Move my 3pm to 4pm&rdquo;</td>
                  <td className="px-3 py-2">
                    Reschedules an existing event
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">&ldquo;What does my week look like?&rdquo;</td>
                  <td className="px-3 py-2">
                    Overview of the entire week&apos;s events
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Find a 30-minute slot for a call this week&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Searches for open windows in your schedule
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">&ldquo;Cancel my Friday standup&rdquo;</td>
                  <td className="px-3 py-2">Removes an event</td>
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
            <li>Connected to your default Google Calendar</li>
            <li>
Supports multiple calendars &mdash; your assistant can view events from any
              calendar on your account and check availability across all of them
            </li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Time zones:</strong> Your assistant uses your local timezone (set in USER.md
              or inferred from your location). If you&apos;re scheduling across timezones, be
              explicit: &ldquo;Schedule at 2pm EST.&rdquo;
            </li>
            <li>
              <strong>Recurring events:</strong> Creating and modifying recurring events works, but
              be specific about what you want changed (&ldquo;just this one&rdquo; vs. &ldquo;all future events&rdquo;).
            </li>
            <li>
              <strong>Multiple calendars:</strong> Your assistant can view events from any
              calendar on your Google account. Just mention the calendar by name:
              &ldquo;What&apos;s on my work calendar tomorrow?&rdquo;
            </li>
            <li>
              <strong>Other calendar providers:</strong> Only Google Calendar is supported right
              now. Outlook, Apple Calendar, and others are on the roadmap.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
