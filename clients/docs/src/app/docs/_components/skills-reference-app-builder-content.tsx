"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-it-does", label: "What it does", level: 2 },
  { id: "setup-required", label: "Setup required", level: 2 },
  { id: "permissions", label: "Permissions", level: 2 },
  { id: "common-prompts", label: "Common prompts", level: 2 },
  { id: "what-it-builds", label: "What it builds", level: 2 },
  { id: "iterating-on-apps", label: "Iterating on apps", level: 2 },
  { id: "app-types", label: "App types", level: 2 },
  { id: "configuration", label: "Configuration", level: 2 },
  { id: "tips-gotchas", label: "Tips & gotchas", level: 2 },
];

export function SkillsReferenceAppBuilderContent() {
  return (
    <>
      <DocsContent title="App Builder" breadcrumb="Docs / Skills Reference / App Builder">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Creates fully interactive web applications from natural language descriptions.
            Dashboards, calculators, trackers, games, tools, landing pages, and anything else
            you can describe.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">None. Works immediately.</p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>No macOS permissions needed (apps run in the sandbox)</li>
            <li>
              Host permissions needed only if the app needs to read/write files on your machine
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
                    &ldquo;Build me a habit tracker&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Creates an interactive app with daily tracking and streaks
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Make a pomodoro timer&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Builds a countdown timer with work/break intervals
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Create a budget dashboard&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Builds an app with categories, charts, and totals
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Build a quiz about world capitals&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Creates an interactive quiz game
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Make a portfolio site for my photography&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Builds a presentational website
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Create a mood tracker with a calendar view&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Builds a visual tracker with date-based input
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Build me a kanban board&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Creates a drag-and-drop task board
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="what-it-builds" className="mt-12">
          <SectionHeading id="what-it-builds" level={2}>
            What it builds
          </SectionHeading>
          <p className="mb-3 text-zinc-600">
            Apps are built as multi-file TypeScript (Preact) projects compiled
            to HTML, CSS, and JavaScript. They:
          </p>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Open in their own panel in the desktop app</li>
            <li>Are fully interactive (buttons, inputs, animations, state)</li>
            <li>Persist so you can come back to them</li>
            <li>Follow a design system with consistent styling</li>
            <li>Can be iterated on after creation</li>
          </ul>
        </section>

        <section id="iterating-on-apps" className="mt-12">
          <SectionHeading id="iterating-on-apps" level={2}>
            Iterating on apps
          </SectionHeading>
          <p className="mb-4 text-zinc-600">First version not quite right? Just say so:</p>
          <blockquote className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Add a dark mode toggle.&rdquo;
          </blockquote>
          <blockquote className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Make the charts bigger.&rdquo;
          </blockquote>
          <blockquote className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Change the color scheme to blues and purples.&rdquo;
          </blockquote>
          <blockquote className="mb-0 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Add an export-to-CSV button.&rdquo;
          </blockquote>
          <p className="mb-0 mt-4 text-zinc-600">
            Your assistant makes targeted edits to the existing app. No need to start over.
          </p>
        </section>

        <section id="app-types" className="mt-12">
          <SectionHeading id="app-types" level={2}>
            App types
          </SectionHeading>
          <div className="mb-0 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Type
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    What it&apos;s for
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Examples
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2"><strong>App</strong> (default)</td>
                  <td className="px-3 py-2">
                    Interactive tools with state and logic
                  </td>
                  <td className="px-3 py-2">
                    Calculators, dashboards, trackers, games
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2"><strong>Site</strong></td>
                  <td className="px-3 py-2">
                    Presentational pages without complex state
                  </td>
                  <td className="px-3 py-2">
                    Portfolios, landing pages, resumes
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
            <li>
              Apps use the Vellum design system by default (semantic colors, spacing, components)
            </li>
            <li>
              You can specify aesthetics: &ldquo;make it minimal,&rdquo; &ldquo;go bold and colorful,&rdquo;
              &ldquo;dark mode&rdquo;
            </li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Be descriptive, not technical.</strong> Say &ldquo;build me a budget tracker with
              categories&rdquo; not &ldquo;create an HTML page with a JavaScript array and DOM manipulation.&rdquo;
              Let your assistant handle the implementation.
            </li>
            <li>
              <strong>Go big.</strong> Your assistant can build surprisingly complex apps. Multi-page
              forms, real-time dashboards, animated games. Don&apos;t limit yourself.
            </li>
            <li>
              <strong>Quality standards:</strong> Apps include hover states, animations, proper
              typography, and responsive layouts by default. If something looks off, just ask for a fix.
            </li>
            <li>
              <strong>Not for long-form writing.</strong> If you want to write a blog post or article,
              use the document editor instead. App Builder is for interactive things.
            </li>
            <li>
              <strong>Home Base</strong> is a special app that serves as your dashboard. You can
              customize it: &ldquo;Add a button to my dashboard for checking email.&rdquo;
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
