/**
 * Route handler for the thread-suggestions catalog endpoint.
 *
 * GET /v1/thread-suggestions: returns grouped suggestion cards for the
 * new-thread empty state, with requirement statuses annotated based on
 * which OAuth providers are actually connected for this assistant.
 *
 * The catalog bundles two kinds of groups:
 *   - plugin groups: suggestions that map to real integrations (Gmail,
 *     Google Calendar, Google Drive). Requirements marked "ready" when the
 *     provider is connected, "install" otherwise.
 *   - vellum-curated: editorially-authored picks that always appear and
 *     never have unmet requirements.
 *
 * The featured row (always-visible above the fold) is the first
 * `featuredCount` suggestions flattened across all groups in order.
 *
 * The catalog content here mirrors clients/web/src/domains/chat/suggestions/
 * mock-suggestions.ts, which serves as the client-side fallback while the
 * fetch is in flight. The server-side copy stores `provider` keys for
 * dynamic status resolution; the client copy stores pre-resolved statuses
 * for the static fallback. Both must be kept in sync by hand when catalog
 * content changes.
 */

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import {
  getServiceMode,
  type Services,
  ServicesSchema,
} from "../../config/schemas/services.js";
import { getProvider, listConnections } from "../../oauth/oauth-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const requirementStatusSchema = z.enum(["ready", "install"]);

const suggestionRequirementSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: requirementStatusSchema,
  hint: z.string().optional(),
});

const suggestionDetailSchema = z.object({
  heading: z.string(),
  description: z.string(),
  requirements: z.array(suggestionRequirementSchema),
  capabilities: z.array(z.string()),
});

const iconKeySchema = z.enum([
  "gmail",
  "google-calendar",
  "google-drive",
  "vellum",
  "generic",
]);

const threadSuggestionSchema = z.object({
  id: z.string(),
  title: z.string(),
  iconKey: iconKeySchema,
  prompt: z.string(),
  detail: suggestionDetailSchema,
});

const suggestionGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: z.enum(["plugin", "vellum-curated"]),
  suggestions: z.array(threadSuggestionSchema),
});

const threadSuggestionsResponseSchema = z.object({
  groups: z.array(suggestionGroupSchema),
  featuredCount: z
    .number()
    .int()
    .describe(
      "How many suggestions from the start of groups form the featured row",
    ),
});

type RequirementStatus = "ready" | "install";

// ---------------------------------------------------------------------------
// Static catalog definitions
// ---------------------------------------------------------------------------

/** Hint shown for requirements that still need installation. */
const INSTALL_HINT = "Need to install this, but it's easy.";

interface StaticRequirement {
  id: string;
  label: string;
  /** Provider key checked in the connected-providers set; undefined = always "ready". */
  provider?: string;
  hint?: string;
}

interface StaticSuggestion {
  id: string;
  title: string;
  iconKey: z.infer<typeof iconKeySchema>;
  prompt: string;
  detail: {
    heading: string;
    description: string;
    requirements: StaticRequirement[];
    capabilities: string[];
  };
}

interface StaticGroup {
  id: string;
  title: string;
  source: "plugin" | "vellum-curated";
  suggestions: StaticSuggestion[];
}

const CATALOG: StaticGroup[] = [
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
          "Help me clean up my Gmail inbox: triage what's important, " +
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
              provider: "gmail",
            },
            {
              id: "email-calendar:clean-inbox:contacts",
              label: "Contacts plugin",
              provider: "contacts",
              hint: INSTALL_HINT,
            },
            {
              id: "email-calendar:clean-inbox:calendar",
              label: "Google Calendar",
              provider: "google-calendar",
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
              provider: "google-calendar",
            },
            {
              id: "email-calendar:meetings-with-dad:contacts",
              label: "Contacts plugin",
              provider: "contacts",
              hint: INSTALL_HINT,
            },
            {
              id: "email-calendar:meetings-with-dad:gmail",
              label: "Gmail",
              provider: "gmail",
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
          "Help me organize my Google Drive: group loose files into folders " +
          "and flag duplicates I can delete.",
        detail: {
          heading: "Drive Helper",
          description:
            "I'll scan your Drive, propose a folder structure that matches " +
            "how you actually work, and move files into place once you sign " +
            "off - no surprises.",
          requirements: [
            {
              id: "files-docs:organize-drive:drive",
              label: "Google Drive connected",
              provider: "google-drive",
            },
            {
              id: "files-docs:organize-drive:docs",
              label: "Docs plugin",
              provider: "docs",
              hint: INSTALL_HINT,
            },
            {
              id: "files-docs:organize-drive:gmail",
              label: "Gmail",
              provider: "gmail",
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
          "Help me build a simple personal website. Gather the pages and " +
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
        prompt: "Help me draft an email. I'll tell you who it's to and why.",
        detail: {
          heading: "Email Drafting",
          description:
            "Give me the gist and the recipient, and I'll draft an email in " +
            "the right tone that you can tweak and send.",
          requirements: [
            {
              id: "vellum-picks:draft-email:vellum",
              label: "Vellum assistant",
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
          "Help me plan a trip: gather options for where to go, where to " +
          "stay, and what to do.",
        detail: {
          heading: "Trip Planner",
          description:
            "Tell me where and when, and I'll put together a realistic " +
            "itinerary with places to stay, things to do, and a rough budget.",
          requirements: [
            { id: "vellum-picks:plan-trip:vellum", label: "Vellum assistant" },
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

const FEATURED_COUNT = 3;

// ---------------------------------------------------------------------------
// Google product scope keywords: a granted scope string containing one of
// these substrings gives access to the corresponding product.
// ---------------------------------------------------------------------------

const GMAIL_SCOPE_KEYWORD = "gmail";
const CALENDAR_SCOPE_KEYWORD = "calendar";
const DRIVE_SCOPE_KEYWORD = "drive";

// ---------------------------------------------------------------------------
// Handler helpers
// ---------------------------------------------------------------------------

function parseGrantedScopes(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Returns true when Google is configured in platform-managed mode.
 * Managed connections hold credentials on the platform side and do not
 * produce local SQLite rows, so they are detected via the service mode
 * config rather than the oauth-store.
 */
function isGoogleManagedMode(): boolean {
  try {
    const providerRow = getProvider("google");
    const managedKey = providerRow?.managedServiceConfigKey;
    if (!managedKey || !(managedKey in ServicesSchema.shape)) {
      return false;
    }
    const services: Services = getConfig().services;
    return getServiceMode(services, managedKey as keyof Services) === "managed";
  } catch {
    return false;
  }
}

/**
 * Builds the set of connected provider keys, used by `resolveStatus` to
 * determine whether a suggestion's requirement is already met.
 *
 * Local BYO connections are read from the oauth-store. For Google connections
 * the granted scopes are inspected so that a Calendar-only grant does not
 * incorrectly mark Gmail and Drive as ready.
 *
 * Platform-managed Google connections bypass local SQLite entirely. When
 * Google is in managed mode the platform handles all three products, so all
 * three product keys are added unconditionally (the platform enforces its
 * own scope grants).
 */
function getConnectedProviders(): Set<string> {
  try {
    const connected = new Set<string>();

    if (isGoogleManagedMode()) {
      connected.add("google");
      connected.add("gmail");
      connected.add("google-calendar");
      connected.add("google-drive");
    }

    const rows = listConnections();
    for (const row of rows) {
      if (row.status !== "active") {
        continue;
      }
      connected.add(row.provider);

      if (row.provider === "google") {
        // Expand to product-level keys only for the scopes actually granted.
        const scopes = parseGrantedScopes(row.grantedScopes);
        if (scopes.length === 0) {
          // Unknown scope data: conservatively grant all three products so
          // we don't block users who connected Google before scope tracking.
          connected.add("gmail");
          connected.add("google-calendar");
          connected.add("google-drive");
        } else {
          if (scopes.some((s) => s.includes(GMAIL_SCOPE_KEYWORD))) {
            connected.add("gmail");
          }
          if (scopes.some((s) => s.includes(CALENDAR_SCOPE_KEYWORD))) {
            connected.add("google-calendar");
          }
          if (scopes.some((s) => s.includes(DRIVE_SCOPE_KEYWORD))) {
            connected.add("google-drive");
          }
        }
      }
    }

    return connected;
  } catch {
    return new Set<string>();
  }
}

function resolveStatus(
  req: StaticRequirement,
  connected: Set<string>,
): RequirementStatus {
  if (!req.provider) {
    return "ready";
  }
  return connected.has(req.provider) ? "ready" : "install";
}

function buildGroups(
  connected: Set<string>,
): z.infer<typeof suggestionGroupSchema>[] {
  return CATALOG.map((group) => ({
    id: group.id,
    title: group.title,
    source: group.source,
    suggestions: group.suggestions.map((s) => ({
      id: s.id,
      title: s.title,
      iconKey: s.iconKey,
      prompt: s.prompt,
      detail: {
        heading: s.detail.heading,
        description: s.detail.description,
        capabilities: s.detail.capabilities,
        requirements: s.detail.requirements.map((req) => ({
          id: req.id,
          label: req.label,
          status: resolveStatus(req, connected),
          ...(req.hint ? { hint: req.hint } : {}),
        })),
      },
    })),
  }));
}

function handleGetThreadSuggestions(): z.infer<
  typeof threadSuggestionsResponseSchema
> {
  const connected = getConnectedProviders();
  return {
    groups: buildGroups(connected),
    featuredCount: FEATURED_COUNT,
  };
}

// ---------------------------------------------------------------------------
// Route export
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "thread_suggestions_get",
    endpoint: "thread-suggestions",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetThreadSuggestions,
    summary: "Get thread suggestion catalog",
    description:
      "Returns grouped suggestion cards for the new-thread empty state, with " +
      "requirement statuses annotated based on which OAuth providers are " +
      "connected for this assistant.",
    tags: ["thread-suggestions"],
    responseBody: threadSuggestionsResponseSchema,
  },
];
