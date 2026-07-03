/**
 * Mocked thread-suggestion data for the new-thread suggestions library.
 *
 * Pure data, typed against {@link SuggestionGroup}. Plugin groups model the
 * "your connected plugins" sections; the vellum-curated group holds
 * editorially-authored picks. The detail drawer, suggestion cards, and the
 * always-visible featured row all read from here.
 */

import type {
  SuggestionGroup,
  ThreadSuggestion,
} from "@/domains/chat/suggestions/types";

/** Reused helper text for requirements that need a one-click install/connect. */
const INSTALL_HINT = "Need to install this, but it's easy.";

export const MOCK_SUGGESTION_GROUPS: SuggestionGroup[] = [
  {
    id: "email-calendar",
    title: "Email & Calendar",
    source: "plugin",
    suggestions: [
      {
        id: "email-calendar:clean-inbox",
        title: "Clean the inbox",
        iconKey: "gmail",
        prompt:
          "Help me clean up my Gmail inbox — triage what's important, " +
          "unsubscribe from noise, and archive what I don't need.",
        detail: {
          heading: "Email Helper",
          description:
            "I'll work through your inbox with you: surfacing the messages " +
            "that actually need a reply, clearing out newsletters and " +
            "receipts, and keeping the important threads front and center.",
          requirements: [
            {
              id: "email-calendar:clean-inbox:gmail",
              label: "Gmail connected",
              status: "ready",
            },
            {
              id: "email-calendar:clean-inbox:contacts",
              label: "Contacts plugin",
              status: "install",
              hint: INSTALL_HINT,
            },
            {
              id: "email-calendar:clean-inbox:calendar",
              label: "Google Calendar",
              status: "install",
              hint: INSTALL_HINT,
            },
          ],
          capabilities: [
            "Triage unread mail into reply-now, later, and archive",
            "Draft replies in your voice for your approval",
            "Bulk-unsubscribe from newsletters you never open",
            "Flag time-sensitive threads before they slip",
            "Summarize long back-and-forth threads",
          ],
        },
      },
      {
        id: "email-calendar:meetings-with-dad",
        title: "Set up meetings with dad",
        iconKey: "google-calendar",
        prompt:
          "Find a recurring time that works for a weekly call with my dad " +
          "and add it to my calendar with a reminder.",
        detail: {
          heading: "Calendar Helper",
          description:
            "I'll look at your existing commitments, find an open recurring " +
            "slot, and set up the event with the right reminders so the call " +
            "actually happens every week.",
          requirements: [
            {
              id: "email-calendar:meetings-with-dad:calendar",
              label: "Google Calendar connected",
              status: "ready",
            },
            {
              id: "email-calendar:meetings-with-dad:contacts",
              label: "Contacts plugin",
              status: "install",
              hint: INSTALL_HINT,
            },
            {
              id: "email-calendar:meetings-with-dad:gmail",
              label: "Gmail",
              status: "install",
              hint: INSTALL_HINT,
            },
          ],
          capabilities: [
            "Find recurring slots that dodge your existing events",
            "Create the event with a video link and reminders",
            "Email an invite to the people you name",
            "Reschedule the next call when something comes up",
            "Add a short agenda to the event description",
          ],
        },
      },
    ],
  },
  {
    id: "files-docs",
    title: "Files & Docs",
    source: "plugin",
    suggestions: [
      {
        id: "files-docs:organize-drive",
        title: "Organize my Drive",
        iconKey: "google-drive",
        prompt:
          "Help me organize my Google Drive — group loose files into folders " +
          "and flag duplicates I can delete.",
        detail: {
          heading: "Drive Helper",
          description:
            "I'll scan your Drive, propose a folder structure that matches " +
            "how you actually work, and move files into place once you sign " +
            "off — no surprises.",
          requirements: [
            {
              id: "files-docs:organize-drive:drive",
              label: "Google Drive connected",
              status: "ready",
            },
            {
              id: "files-docs:organize-drive:docs",
              label: "Docs plugin",
              status: "install",
              hint: INSTALL_HINT,
            },
            {
              id: "files-docs:organize-drive:gmail",
              label: "Gmail",
              status: "install",
              hint: INSTALL_HINT,
            },
          ],
          capabilities: [
            "Propose a folder structure from your existing files",
            "Move loose files into the right folders on approval",
            "Surface likely duplicates to clean up",
            "Rename files to a consistent convention",
            "Find documents you can't remember the name of",
          ],
        },
      },
    ],
  },
  // Vellum-curated picks: placeholder/mock suggestions rendered behind the
  // new-thread-suggestions feature flag.
  {
    id: "vellum-picks",
    title: "Vellum picks",
    source: "vellum-curated",
    suggestions: [
      {
        id: "vellum-picks:build-website",
        title: "Build a website",
        iconKey: "vellum",
        prompt:
          "Help me build a simple personal website — gather the pages and " +
          "content I need and scaffold it out.",
        detail: {
          heading: "Website Builder",
          description:
            "Tell me what the site is for and I'll plan the pages, draft the " +
            "copy, and scaffold a clean starting point you can refine.",
          requirements: [
            {
              id: "vellum-picks:build-website:vellum",
              label: "Vellum assistant",
              status: "ready",
            },
          ],
          capabilities: [
            "Plan the pages and structure for your site",
            "Draft headlines and body copy",
            "Scaffold a clean, responsive starting point",
            "Suggest a color palette and typography",
            "Iterate on sections until they feel right",
          ],
        },
      },
      {
        id: "vellum-picks:summarize-week",
        title: "Summarize my week",
        iconKey: "vellum",
        prompt:
          "Pull together a summary of what I worked on this week and what's " +
          "still open.",
        detail: {
          heading: "Weekly Recap",
          description:
            "I'll gather the threads, docs, and tasks you touched this week " +
            "and turn them into a tight recap of what shipped and what's " +
            "still in flight.",
          requirements: [
            {
              id: "vellum-picks:summarize-week:vellum",
              label: "Vellum assistant",
              status: "ready",
            },
          ],
          capabilities: [
            "Roll up what you worked on across the week",
            "Separate what shipped from what's still open",
            "Highlight blockers worth flagging",
            "Draft an update you can share with your team",
            "Carry open items into next week",
          ],
        },
      },
      {
        id: "vellum-picks:draft-email",
        title: "Draft an email",
        iconKey: "vellum",
        prompt: "Help me draft an email — I'll tell you who it's to and why.",
        detail: {
          heading: "Email Drafting",
          description:
            "Give me the gist and the recipient, and I'll draft an email in " +
            "the right tone that you can tweak and send.",
          requirements: [
            {
              id: "vellum-picks:draft-email:vellum",
              label: "Vellum assistant",
              status: "ready",
            },
          ],
          capabilities: [
            "Draft an email from a quick description",
            "Match the tone to the recipient",
            "Tighten a rambling draft into something clear",
            "Suggest subject lines",
            "Adapt the same message for different audiences",
          ],
        },
      },
      {
        id: "vellum-picks:plan-trip",
        title: "Plan a trip",
        iconKey: "vellum",
        prompt:
          "Help me plan a trip — gather options for where to go, where to " +
          "stay, and what to do.",
        detail: {
          heading: "Trip Planner",
          description:
            "Tell me where and when, and I'll put together a realistic " +
            "itinerary with places to stay, things to do, and a rough budget.",
          requirements: [
            {
              id: "vellum-picks:plan-trip:vellum",
              label: "Vellum assistant",
              status: "ready",
            },
          ],
          capabilities: [
            "Suggest destinations that fit your dates and budget",
            "Build a day-by-day itinerary",
            "Compare places to stay",
            "Surface things to do and see",
            "Estimate a rough budget",
          ],
        },
      },
      {
        id: "vellum-picks:research-topic",
        title: "Research a topic",
        iconKey: "vellum",
        prompt:
          "Help me research a topic and pull together the key findings with " +
          "sources.",
        detail: {
          heading: "Research Assistant",
          description:
            "Name a topic and I'll dig into it, pull together the key " +
            "findings, and cite where each one came from so you can trust it.",
          requirements: [
            {
              id: "vellum-picks:research-topic:vellum",
              label: "Vellum assistant",
              status: "ready",
            },
          ],
          capabilities: [
            "Gather findings from multiple sources",
            "Summarize the key points clearly",
            "Cite sources so you can verify",
            "Flag where the sources disagree",
            "Go deeper on the angles you care about",
          ],
        },
      },
    ],
  },
];

/**
 * Returns the first `count` suggestions across all groups, flattened in group
 * order. Used for the always-visible featured row at the fold.
 */
export function getFeaturedSuggestions(count = 3): ThreadSuggestion[] {
  return MOCK_SUGGESTION_GROUPS.flatMap((group) => group.suggestions).slice(
    0,
    count,
  );
}
