/**
 * Read-only perception routes.
 *
 * These routes expose the daemon-side, memory-only `ContextBuffer` to
 * internal clients and first-party skills. They do not start perception,
 * mutate memory, or request host access.
 */

import { z } from "zod";

import {
  hasActivePerceptionConsent,
  type PerceptionConsentEventKind,
} from "../../perception/consent-grants.js";
import {
  PERCEPTION_EVENT_KINDS,
  type PerceptionEvent,
  type PerceptionEventKind,
  PerceptionEventSchema,
  perceptionEventType,
} from "../../perception/perception-event.js";
import {
  sanitizeOptional,
  sanitizeText,
} from "../../perception/sanitization.js";
import { getPerceptionBuffer } from "../../perception/startup.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const CONSENT_GATED_KINDS = new Set<PerceptionEventKind>([
  "screen_snapshot",
  "audio_excerpt",
]);

function isConsentGatedKind(
  kind: PerceptionEventKind,
): kind is PerceptionConsentEventKind {
  return CONSENT_GATED_KINDS.has(kind);
}

/**
 * Defense-in-depth: scrub user-visible string fields on caller-provided
 * perception payloads before they cross into the event hub or context buffer.
 *
 * The producer (Tauri/macOS capture skill) is the primary redactor, but we
 * never trust a caller's claim that text is already redacted — Phase 9
 * invariant: "no raw secrets". A buggy or compromised client cannot leak
 * unredacted text past this route.
 */
function sanitizeIncomingPerceptionEvent(
  event: PerceptionEvent,
): PerceptionEvent {
  const payload = event.payload;
  switch (payload.kind) {
    case "app_focus_changed":
      return {
        ...event,
        payload: {
          ...payload,
          appId: sanitizeText(payload.appId, 256),
          appName: sanitizeText(payload.appName, 256),
          windowTitle: sanitizeText(payload.windowTitle, 512),
        },
      };
    case "task_detected":
      return {
        ...event,
        payload: {
          ...payload,
          label: sanitizeText(payload.label, 120),
          summary: sanitizeText(payload.summary, 320),
        },
      };
    case "meeting_started":
      return {
        ...event,
        payload: { ...payload, summary: sanitizeText(payload.summary, 320) },
      };
    case "code_edited":
      return {
        ...event,
        payload: {
          ...payload,
          summary: sanitizeText(payload.summary, 320),
          workspaceHint: sanitizeOptional(payload.workspaceHint, 120),
          languageHint: sanitizeOptional(payload.languageHint, 40),
        },
      };
    case "relevance_scored":
      return {
        ...event,
        payload: { ...payload, reason: sanitizeOptional(payload.reason, 240) },
      };
    case "screen_snapshot":
      return {
        ...event,
        payload: {
          ...payload,
          appId: sanitizeText(payload.appId, 256),
          appName: sanitizeText(payload.appName, 256),
          windowTitle: sanitizeText(payload.windowTitle, 512),
          ocrTextRedacted: sanitizeText(payload.ocrTextRedacted, 2048),
        },
      };
    case "audio_excerpt":
      return {
        ...event,
        payload: {
          ...payload,
          sessionId: sanitizeText(payload.sessionId, 128),
          turnId: sanitizeText(payload.turnId, 128),
          transcriptRedacted: sanitizeText(payload.transcriptRedacted, 1024),
          language: sanitizeOptional(payload.language, 20),
        },
      };
  }
}

const RecentPerceptionQuerySchema = z.object({
  windowMs: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  kind: z.enum(PERCEPTION_EVENT_KINDS).optional(),
});

const BufferedPerceptionEventSchema = z.object({
  receivedAt: z.string().datetime(),
  event: PerceptionEventSchema,
});

const RecentPerceptionResponseSchema = z.object({
  enabled: z.boolean(),
  entries: z.array(BufferedPerceptionEventSchema),
});

const PublishPerceptionResponseSchema = z.object({
  accepted: z.boolean(),
  reason: z.enum(["disabled", "consent_required"]).optional(),
});

function handleRecentPerception({ queryParams = {} }: RouteHandlerArgs) {
  const query = RecentPerceptionQuerySchema.parse(queryParams);
  const buffer = getPerceptionBuffer();
  if (!buffer) {
    return { enabled: false, entries: [] };
  }

  const entries = buffer.recent({
    windowMs: query.windowMs,
    limit: query.limit,
    kind: query.kind as PerceptionEventKind | undefined,
  });

  return {
    enabled: true,
    entries: entries.map((entry) => ({
      receivedAt: entry.receivedAt.toISOString(),
      event: entry.event,
    })),
  };
}

async function handlePublishPerception({ body = {} }: RouteHandlerArgs) {
  const parsed = PerceptionEventSchema.parse(body);
  const buffer = getPerceptionBuffer();
  if (!buffer) {
    return { accepted: false, reason: "disabled" as const };
  }

  const perception = sanitizeIncomingPerceptionEvent(parsed);

  if (isConsentGatedKind(perception.payload.kind)) {
    const conversationId = (perception.payload as { conversationId: string })
      .conversationId;
    const allowed = hasActivePerceptionConsent({
      conversationId,
      eventKind: perception.payload.kind,
    });
    if (!allowed) {
      return { accepted: false, reason: "consent_required" as const };
    }
  }

  await assistantEventHub.publish({
    id: perception.eventId,
    emittedAt: new Date().toISOString(),
    message: {
      type: perceptionEventType(perception.payload.kind),
      perception,
    },
  } as never);

  return { accepted: true };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "perception_recent",
    endpoint: "perception/recent",
    method: "GET",
    handler: handleRecentPerception,
    summary: "List recent perception events",
    description:
      "Read recent structured perception events from the daemon's memory-only buffer. Returns an empty result when perception is disabled.",
    tags: ["perception"],
    queryParams: [
      {
        name: "windowMs",
        type: "integer",
        description: "Only return events received within the last N ms.",
      },
      {
        name: "limit",
        type: "integer",
        description: "Maximum number of events to return, most recent first.",
      },
      {
        name: "kind",
        schema: {
          type: "string",
          enum: [...PERCEPTION_EVENT_KINDS],
        },
        description: "Restrict results to a perception event kind.",
      },
    ],
    responseBody: RecentPerceptionResponseSchema,
  },
  {
    operationId: "perception_publish",
    endpoint: "perception/publish",
    method: "POST",
    handler: handlePublishPerception,
    summary: "Publish a perception event",
    description:
      "Validate and publish one structured perception event into the assistant event hub. Returns accepted=false when perception is disabled.",
    tags: ["perception"],
    requestBody: PerceptionEventSchema,
    responseBody: PublishPerceptionResponseSchema,
  },
];
