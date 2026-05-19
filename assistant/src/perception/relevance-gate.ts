import { z } from "zod";

import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../memory/checkpoints.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { deleteConversation } from "../memory/conversation-crud.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import type { Provider } from "../providers/types.js";
import {
  wakeAgentForOpportunity,
  type WakeResult,
} from "../runtime/agent-wake.js";
import type {
  AssistantEventHub,
  AssistantEventSubscription,
} from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import {
  parsePerceptionEvent,
  PERCEPTION_EVENT_TYPE_PREFIX,
  type PerceptionEvent,
  perceptionEventType,
  type RelevanceDecision as RelevanceDecisionKind,
  type RelevanceUrgency,
} from "./perception-event.js";
import { sanitizeOptional, sanitizeText } from "./sanitization.js";

const log = getLogger("perception-relevance-gate");

const ACT_NOW_BUDGET_KEY = "perception:act-now:hourly-timestamps";
const DEFAULT_HOURLY_ACT_NOW_BUDGET = 2;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5_000;

const RelevanceDecisionSchema = z.object({
  decision: z.enum(["ignore", "remember", "maybe-act", "act-now"]),
  urgency: z.enum(["low", "medium", "high"]).optional(),
  reason: z.string().max(240).optional(),
});

const RELEVANCE_PROMPT = `Classify one interpreted perception event.
Return strict JSON only:
{"decision":"ignore"|"remember"|"maybe-act"|"act-now","urgency":"low"|"medium"|"high","reason":"..."}

Policy:
- Use "ignore" for low-signal/noisy events.
- Use "remember" for useful context that should be retained but no immediate action.
- Use "maybe-act" for potentially actionable signals that should wait for more context.
- Use "act-now" only when immediate proactive follow-up is likely valuable.
- "high" urgency is rare and only for time-sensitive opportunities.
- Never include secrets, URLs, emails, phone numbers, or account IDs in reason.
- Output JSON only.`;

type InterpretedKind = "task_detected" | "meeting_started" | "code_edited";

export interface RelevanceDecision {
  decision: RelevanceDecisionKind;
  urgency: RelevanceUrgency;
  reason?: string;
}

interface ActNowOutcome {
  triggeredWake: boolean;
  blockedByBudget: boolean;
  wakeConversationId?: string;
}

export interface PerceptionRelevanceGateOptions {
  getProvider?: () => Promise<Provider | null>;
  now?: () => Date;
  hourlyActNowBudget?: number;
  timeoutMs?: number;
  wakeAgent?: (opts: {
    conversationId: string;
    hint: string;
    source: string;
  }) => Promise<WakeResult>;
  bootstrapConversation?: () => { id: string };
  deleteConversation?: (conversationId: string) => void;
  getCheckpoint?: (key: string) => string | null;
  setCheckpoint?: (key: string, value: string) => void;
}

export class PerceptionRelevanceGate {
  private readonly getProvider: () => Promise<Provider | null>;
  private readonly now: () => Date;
  private readonly hourlyActNowBudget: number;
  private readonly timeoutMs: number;
  private readonly wakeAgent: (opts: {
    conversationId: string;
    hint: string;
    source: string;
  }) => Promise<WakeResult>;
  private readonly bootstrapConversation: () => { id: string };
  private readonly deleteConversation: (conversationId: string) => void;
  private readonly getCheckpoint: (key: string) => string | null;
  private readonly setCheckpoint: (key: string, value: string) => void;
  private subscription: AssistantEventSubscription | null = null;
  private hub: AssistantEventHub | null = null;

  constructor(options: PerceptionRelevanceGateOptions = {}) {
    this.getProvider =
      options.getProvider ?? (() => getConfiguredProvider("perception"));
    this.now = options.now ?? (() => new Date());
    this.hourlyActNowBudget =
      options.hourlyActNowBudget ?? DEFAULT_HOURLY_ACT_NOW_BUDGET;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.wakeAgent =
      options.wakeAgent ??
      ((opts) =>
        wakeAgentForOpportunity({
          conversationId: opts.conversationId,
          hint: opts.hint,
          source: opts.source,
        }));
    this.bootstrapConversation =
      options.bootstrapConversation ??
      (() =>
        bootstrapConversation({
          conversationType: "background",
          source: "perception_proactive",
          origin: "watcher",
          systemHint: "Perception proactive check",
          groupId: "system:background",
        }));
    this.deleteConversation = options.deleteConversation ?? deleteConversation;
    this.getCheckpoint = options.getCheckpoint ?? getMemoryCheckpoint;
    this.setCheckpoint = options.setCheckpoint ?? setMemoryCheckpoint;
  }

  attach(hub: AssistantEventHub): AssistantEventSubscription {
    if (this.subscription) return this.subscription;
    this.hub = hub;
    this.subscription = hub.subscribe({
      type: "process",
      callback: async (event) => {
        try {
          await this.ingest(event);
        } catch (err) {
          log.warn({ err }, "relevance gate ingest failed");
        }
      },
    });
    return this.subscription;
  }

  detach(): void {
    this.subscription?.dispose();
    this.subscription = null;
    this.hub = null;
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

    if (!isInterpretedKind(parsed.payload.kind)) return;

    const decision = await this.classify(parsed);
    const outcome: ActNowOutcome =
      decision.decision === "act-now"
        ? await this.maybeTriggerActNow(parsed, decision)
        : { triggeredWake: false, blockedByBudget: false };
    await this.emitDecisionEvent(parsed, decision, outcome);
  }

  private async classify(event: PerceptionEvent): Promise<RelevanceDecision> {
    const provider = await this.getProvider();
    if (!provider) return fallbackDecision(event);

    const prompt = JSON.stringify(
      {
        eventId: event.eventId,
        ts: event.ts,
        kind: event.payload.kind,
        payload: event.payload,
      },
      null,
      2,
    );

    try {
      const response = await provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: prompt }] }],
        undefined,
        RELEVANCE_PROMPT,
        {
          signal: AbortSignal.timeout(this.timeoutMs),
          config: { callSite: "perception", max_tokens: 256 },
        },
      );
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      const parsed = RelevanceDecisionSchema.safeParse(
        parseJsonObjectFromText(text),
      );
      if (!parsed.success) return fallbackDecision(event);
      return {
        decision: parsed.data.decision,
        urgency: parsed.data.urgency ?? "low",
        reason: sanitizeReason(parsed.data.reason),
      };
    } catch (err) {
      log.debug({ err }, "relevance classification failed");
      return fallbackDecision(event);
    }
  }

  private async maybeTriggerActNow(
    event: PerceptionEvent,
    decision: RelevanceDecision,
  ): Promise<ActNowOutcome> {
    const nowMs = this.now().getTime();
    const prior = this.readRecentActNowTimestamps(nowMs);
    if (
      decision.urgency !== "high" &&
      prior.length >= this.hourlyActNowBudget
    ) {
      log.info(
        {
          eventId: event.eventId,
          kind: event.payload.kind,
          hourlyActNowBudget: this.hourlyActNowBudget,
        },
        "act-now skipped due to hourly interruption budget",
      );
      this.writeActNowTimestamps(prior);
      return { triggeredWake: false, blockedByBudget: true };
    }

    const conversation = this.bootstrapConversation();
    const current = [...prior, nowMs];
    this.writeActNowTimestamps(current);

    const hint = buildActNowHint(event, decision);
    const wake = await this.wakeAgent({
      conversationId: conversation.id,
      hint,
      source: "perception_proactive",
    });

    if (!wake.invoked) {
      // Roll back budget consumption for failed wake attempts.
      this.writeActNowTimestamps(prior);
      try {
        this.deleteConversation(conversation.id);
      } catch (err) {
        log.warn({ err, conversationId: conversation.id }, "failed cleanup");
      }
      return { triggeredWake: false, blockedByBudget: false };
    }

    log.info(
      {
        eventId: event.eventId,
        kind: event.payload.kind,
        urgency: decision.urgency,
        conversationId: conversation.id,
      },
      "act-now proactive wake invoked",
    );
    return {
      triggeredWake: true,
      blockedByBudget: false,
      wakeConversationId: conversation.id,
    };
  }

  private async emitDecisionEvent(
    sourceEvent: PerceptionEvent,
    decision: RelevanceDecision,
    outcome: ActNowOutcome,
  ): Promise<void> {
    if (!this.hub) return;

    const emittedAt = this.now().toISOString();
    const eventId = `relevance-${sourceEvent.eventId}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const perceptionEvent: PerceptionEvent = {
      eventId,
      ts: emittedAt,
      source: {
        module: "assistant/perception-relevance-gate",
      },
      payload: {
        kind: "relevance_scored",
        sourceEventId: sourceEvent.eventId,
        sourceKind: sourceEvent.payload.kind as InterpretedKind,
        decision: decision.decision,
        urgency: decision.urgency,
        reason: decision.reason,
        triggeredWake: outcome.triggeredWake,
        blockedByBudget: outcome.blockedByBudget,
        wakeConversationId: outcome.wakeConversationId,
      },
    };

    try {
      await this.hub.publish({
        id: eventId,
        emittedAt,
        message: {
          type: perceptionEventType("relevance_scored"),
          perception: perceptionEvent,
        },
      } as never);
    } catch (err) {
      log.warn({ err, eventId }, "failed to publish relevance_scored event");
    }
  }

  private readRecentActNowTimestamps(nowMs: number): number[] {
    const raw = this.getCheckpoint(ACT_NOW_BUDGET_KEY);
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const cutoff = nowMs - HOUR_MS;
    return parsed
      .map((value) => (typeof value === "number" ? value : Number.NaN))
      .filter((value) => Number.isFinite(value) && value >= cutoff);
  }

  private writeActNowTimestamps(timestamps: number[]): void {
    this.setCheckpoint(ACT_NOW_BUDGET_KEY, JSON.stringify(timestamps));
  }
}

function parseJsonObjectFromText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // continue with extraction fallback
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim());
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }
  throw new Error("missing JSON object");
}

function sanitizeReason(reason: string | undefined): string | undefined {
  return sanitizeOptional(reason, 240);
}

function fallbackDecision(event: PerceptionEvent): RelevanceDecision {
  if (
    event.payload.kind === "meeting_started" &&
    event.payload.confidence >= 0.9
  ) {
    return {
      decision: "act-now",
      urgency: "high",
      reason: "High-confidence meeting transition detected.",
    };
  }
  if (
    event.payload.kind === "task_detected" &&
    event.payload.confidence >= 0.85
  ) {
    return {
      decision: "maybe-act",
      urgency: "medium",
      reason: "Potentially actionable task context.",
    };
  }
  if (event.payload.kind === "code_edited" && event.payload.confidence >= 0.8) {
    return {
      decision: "remember",
      urgency: "low",
      reason: "Useful coding context for future turns.",
    };
  }
  return { decision: "ignore", urgency: "low", reason: "Low-signal context." };
}

function buildActNowHint(
  event: PerceptionEvent,
  decision: RelevanceDecision,
): string {
  const payloadText = sanitizeHintText(JSON.stringify(event.payload));
  return `Perception triggered an act-now opportunity.

Event kind: ${event.payload.kind}
Event id: ${event.eventId}
Urgency: ${decision.urgency}
Reason: ${decision.reason ?? "not provided"}
Payload (redacted): ${payloadText}

Decide whether a proactive outreach is appropriate right now. If yes, produce a concise, high-signal proactive message. If not, do a silent no-op.`;
}

function sanitizeHintText(value: string): string {
  return sanitizeText(value, 500);
}

function isInterpretedKind(kind: string): kind is InterpretedKind {
  return (
    kind === "task_detected" ||
    kind === "meeting_started" ||
    kind === "code_edited"
  );
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
