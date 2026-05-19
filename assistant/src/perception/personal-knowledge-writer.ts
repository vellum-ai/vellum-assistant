import {
  recordPkbEpisode,
  upsertPkbEntity,
  upsertPkbPreference,
} from "../memory/personal-knowledge-store.js";
import type {
  AssistantEventHub,
  AssistantEventSubscription,
} from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import {
  type CodeEditedPayload,
  type MeetingStartedPayload,
  parsePerceptionEvent,
  PERCEPTION_EVENT_TYPE_PREFIX,
  type PerceptionEvent,
  type TaskDetectedPayload,
} from "./perception-event.js";

const log = getLogger("perception-pkb-writer");

const SOURCE_CACHE_TTL_MS = 10 * 60 * 1000;
const SOURCE_CACHE_MAX = 1000;
const DEFAULT_SCOPE_ID = "default";

type InterpretedPayload =
  | TaskDetectedPayload
  | MeetingStartedPayload
  | CodeEditedPayload;

interface CachedInterpreted {
  event: PerceptionEvent;
  storedAtMs: number;
}

export class PersonalKnowledgeWriter {
  private subscription: AssistantEventSubscription | null = null;
  private interpretedByEventId = new Map<string, CachedInterpreted>();

  attach(hub: AssistantEventHub): AssistantEventSubscription {
    if (this.subscription) return this.subscription;
    this.subscription = hub.subscribe({
      type: "process",
      callback: async (event) => {
        try {
          await this.ingest(event);
        } catch (err) {
          log.warn({ err }, "personal knowledge writer ingest failed");
        }
      },
    });
    return this.subscription;
  }

  detach(): void {
    this.subscription?.dispose();
    this.subscription = null;
    this.interpretedByEventId.clear();
  }

  async ingest(event: unknown): Promise<void> {
    const type = getEventType(event);
    if (!type || !type.startsWith(`${PERCEPTION_EVENT_TYPE_PREFIX}.`)) return;

    const message = getEventMessage(event);
    if (!message) return;

    const candidate = extractPerceptionPayload(message);
    let parsed: PerceptionEvent;
    try {
      parsed = parsePerceptionEvent(candidate);
    } catch {
      return;
    }

    this.pruneSourceCache();

    switch (parsed.payload.kind) {
      case "task_detected":
      case "meeting_started":
      case "code_edited":
        this.cacheInterpreted(parsed);
        return;
      case "relevance_scored":
        await this.persistRelevantDecision(parsed);
        return;
      default:
        return;
    }
  }

  private cacheInterpreted(event: PerceptionEvent): void {
    this.interpretedByEventId.set(event.eventId, {
      event,
      storedAtMs: Date.now(),
    });
    if (this.interpretedByEventId.size <= SOURCE_CACHE_MAX) return;
    const oldest = this.interpretedByEventId.keys().next().value as
      | string
      | undefined;
    if (oldest) this.interpretedByEventId.delete(oldest);
  }

  private async persistRelevantDecision(event: PerceptionEvent): Promise<void> {
    if (event.payload.kind !== "relevance_scored") return;
    if (event.payload.decision === "ignore") return;

    const source = this.interpretedByEventId.get(
      event.payload.sourceEventId,
    )?.event;
    if (!source) return;

    const interpreted = source.payload as InterpretedPayload;
    const observedAt = Date.parse(source.ts) || Date.now();
    const provenance = {
      source: "perception",
      sourceEventId: source.eventId,
      observedAt,
    };
    const { entityId, episodeSummary } = this.ensureEntityAndEpisodeSummary(
      interpreted,
      provenance,
    );

    recordPkbEpisode({
      scopeId: DEFAULT_SCOPE_ID,
      entityId,
      summary: episodeSummary,
      details: {
        sourceEventId: source.eventId,
        relevanceEventId: event.eventId,
        relevanceDecision: event.payload.decision,
        relevanceUrgency: event.payload.urgency,
        relevanceReason: event.payload.reason,
        sourceKind: interpreted.kind,
      },
      happenedAt: observedAt,
      salience: salienceForDecision(
        event.payload.decision,
        event.payload.urgency,
      ),
      sourceConversationId: event.payload.wakeConversationId,
      idempotencyKey: `${source.eventId}:${interpreted.kind}`,
    });

    this.learnPreference(interpreted);
  }

  private ensureEntityAndEpisodeSummary(
    interpreted: InterpretedPayload,
    provenance: { source: string; sourceEventId: string; observedAt: number },
  ): {
    entityId?: string;
    episodeSummary: string;
  } {
    switch (interpreted.kind) {
      case "task_detected": {
        const entity = upsertPkbEntity({
          scopeId: DEFAULT_SCOPE_ID,
          entityType: "task",
          canonicalName: interpreted.label,
          aliases: [],
          attributes: { summary: interpreted.summary },
          confidence: interpreted.confidence,
          provenance,
        });
        return {
          entityId: entity.id,
          episodeSummary: interpreted.summary || interpreted.label,
        };
      }
      case "meeting_started": {
        const name = interpreted.platform ?? "meeting";
        const entity = upsertPkbEntity({
          scopeId: DEFAULT_SCOPE_ID,
          entityType: "meeting-platform",
          canonicalName: name,
          aliases: [],
          attributes: { summary: interpreted.summary },
          confidence: interpreted.confidence,
          provenance,
        });
        return { entityId: entity.id, episodeSummary: interpreted.summary };
      }
      case "code_edited": {
        const workspace = interpreted.workspaceHint?.trim();
        if (workspace) {
          const entity = upsertPkbEntity({
            scopeId: DEFAULT_SCOPE_ID,
            entityType: "workspace",
            canonicalName: workspace,
            aliases: interpreted.languageHint ? [interpreted.languageHint] : [],
            attributes: { summary: interpreted.summary },
            confidence: interpreted.confidence,
            provenance,
          });
          return { entityId: entity.id, episodeSummary: interpreted.summary };
        }
        const language = interpreted.languageHint?.trim();
        if (language) {
          const entity = upsertPkbEntity({
            scopeId: DEFAULT_SCOPE_ID,
            entityType: "language",
            canonicalName: language,
            aliases: [],
            attributes: { summary: interpreted.summary },
            confidence: interpreted.confidence,
            provenance,
          });
          return { entityId: entity.id, episodeSummary: interpreted.summary };
        }
        return { episodeSummary: interpreted.summary };
      }
    }
  }

  private learnPreference(interpreted: InterpretedPayload): void {
    if (interpreted.kind === "code_edited" && interpreted.languageHint) {
      upsertPkbPreference({
        scopeId: DEFAULT_SCOPE_ID,
        key: "coding.language.preferred",
        value: interpreted.languageHint,
        confidence: interpreted.confidence,
        learnedFrom: "perception",
      });
    }
    if (interpreted.kind === "meeting_started" && interpreted.platform) {
      upsertPkbPreference({
        scopeId: DEFAULT_SCOPE_ID,
        key: "meeting.platform.preferred",
        value: interpreted.platform,
        confidence: interpreted.confidence,
        learnedFrom: "perception",
      });
    }
  }

  private pruneSourceCache(): void {
    const cutoff = Date.now() - SOURCE_CACHE_TTL_MS;
    for (const [id, item] of this.interpretedByEventId.entries()) {
      if (item.storedAtMs < cutoff) {
        this.interpretedByEventId.delete(id);
      }
    }
  }
}

function salienceForDecision(
  decision: "remember" | "maybe-act" | "act-now",
  urgency: "low" | "medium" | "high",
): number {
  const base =
    decision === "act-now" ? 0.9 : decision === "maybe-act" ? 0.7 : 0.5;
  const urgencyBoost =
    urgency === "high" ? 0.1 : urgency === "medium" ? 0.05 : 0;
  return Math.max(0, Math.min(1, base + urgencyBoost));
}

function getEventType(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function getEventMessage(event: unknown): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object") return undefined;
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  return message as Record<string, unknown>;
}

function extractPerceptionPayload(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const nested = message.perception;
  if (nested && typeof nested === "object") {
    return nested as Record<string, unknown>;
  }
  return message;
}
