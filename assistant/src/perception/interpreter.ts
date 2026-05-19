import { z } from "zod";

import { getConfiguredProvider } from "../providers/provider-send-message.js";
import type { Provider } from "../providers/types.js";
import type {
  AssistantEventHub,
  AssistantEventSubscription,
} from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import {
  type AppFocusChangedPayload,
  type MeetingStartedPayload,
  parsePerceptionEvent,
  PERCEPTION_EVENT_TYPE_PREFIX,
  type PerceptionEvent,
  perceptionEventType,
} from "./perception-event.js";
import { sanitizeOptional, sanitizeText } from "./sanitization.js";

const log = getLogger("perception-interpreter");

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MIN_CONFIDENCE = 0.5;
const DEFAULT_DEBOUNCE_MS = 2_000;

const InterpretedKindSchema = z.enum([
  "task_detected",
  "meeting_started",
  "code_edited",
]);

const InterpreterDecisionSchema = z.object({
  emit: z.boolean(),
  kind: InterpretedKindSchema.optional(),
  label: z.string().min(1).max(120).optional(),
  summary: z.string().min(1).max(320).optional(),
  confidence: z.number().min(0).max(1).optional(),
  platform: z
    .enum(["zoom", "google-meet", "teams", "slack-huddle", "other"])
    .optional(),
  workspaceHint: z.string().max(120).optional(),
  languageHint: z.string().max(40).optional(),
});

const PERCEPTION_INTERPRETER_PROMPT = `You interpret local desktop context into structured task signals.
Return strict JSON only with this schema:
{
  "emit": boolean,
  "kind"?: "task_detected" | "meeting_started" | "code_edited",
  "label"?: string,
  "summary"?: string,
  "confidence"?: number,
  "platform"?: "zoom" | "google-meet" | "teams" | "slack-huddle" | "other",
  "workspaceHint"?: string,
  "languageHint"?: string
}

Rules:
- Focus only on the provided app and redacted window title.
- Do NOT include emails, URLs, phone numbers, API keys, account IDs, or other sensitive identifiers.
- If the signal is too weak or generic, return {"emit":false}.
- Use "meeting_started" when the signal strongly indicates an active meeting.
- Use "code_edited" when the signal strongly indicates active coding/editing.
- Use "task_detected" for all other meaningful task signals.
- If emitting, keep label concise (<= 120 chars) and summary short (<= 320 chars).
- confidence must be between 0 and 1.
- Include optional fields only when strongly supported.
- Output JSON only.`;

type InterpretedEmission =
  | {
      kind: "task_detected";
      label: string;
      summary: string;
      confidence: number;
    }
  | {
      kind: "meeting_started";
      summary: string;
      confidence: number;
      platform?: MeetingStartedPayload["platform"];
    }
  | {
      kind: "code_edited";
      summary: string;
      confidence: number;
      workspaceHint?: string;
      languageHint?: string;
    };

export interface PerceptionInterpreterOptions {
  getProvider?: () => Promise<Provider | null>;
  now?: () => Date;
  timeoutMs?: number;
  minConfidence?: number;
  debounceMs?: number;
}

export class PerceptionInterpreter {
  private readonly getProvider: () => Promise<Provider | null>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly minConfidence: number;
  private readonly debounceMs: number;
  private readonly lastInterpretationByFocusKey = new Map<string, number>();
  private subscription: AssistantEventSubscription | null = null;
  private hub: AssistantEventHub | null = null;

  constructor(options: PerceptionInterpreterOptions = {}) {
    this.getProvider =
      options.getProvider ?? (() => getConfiguredProvider("perception"));
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  attach(hub: AssistantEventHub): AssistantEventSubscription {
    if (this.subscription) return this.subscription;
    this.hub = hub;
    this.subscription = hub.subscribe({
      type: "process",
      callback: async (event) => {
        await this.ingest(event);
      },
    });
    return this.subscription;
  }

  detach(): void {
    this.subscription?.dispose();
    this.subscription = null;
    this.hub = null;
    this.lastInterpretationByFocusKey.clear();
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

    if (parsed.payload.kind !== "app_focus_changed") return;
    const appFocusEvent = parsed as PerceptionEvent & {
      payload: AppFocusChangedPayload;
    };
    if (this.shouldDebounce(appFocusEvent)) return;

    const inferred = await this.interpretAppFocus(appFocusEvent);
    if (!inferred) return;

    await this.publishInterpretedEvent(parsed, inferred);
  }

  private async interpretAppFocus(
    event: PerceptionEvent & { payload: AppFocusChangedPayload },
  ): Promise<InterpretedEmission | null> {
    try {
      const provider = await this.getProvider();
      if (!provider) return null;

      const redactedTitle = sanitizeForPrompt(event.payload.windowTitle);
      const userInput = JSON.stringify(
        {
          eventId: event.eventId,
          timestamp: event.ts,
          appId: sanitizeForPrompt(event.payload.appId),
          appName: sanitizeForPrompt(event.payload.appName),
          windowTitle: event.payload.redacted ? "" : redactedTitle,
          titleRedactedAtSource: event.payload.redacted,
        },
        null,
        2,
      );

      const response = await provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: userInput }] }],
        undefined,
        PERCEPTION_INTERPRETER_PROMPT,
        {
          signal: AbortSignal.timeout(this.timeoutMs),
          config: { callSite: "perception" },
        },
      );
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (text.length === 0) return null;

      const parsedDecision = InterpreterDecisionSchema.safeParse(
        parseJsonObjectFromText(text),
      );
      if (!parsedDecision.success) return null;
      if (!parsedDecision.data.emit) return null;

      const confidence = parsedDecision.data.confidence ?? 0.5;
      if (confidence < this.minConfidence) return null;

      const kind = parsedDecision.data.kind ?? "task_detected";
      const summary = sanitizeForEmission(parsedDecision.data.summary ?? "");
      if (!summary) return null;

      if (kind === "meeting_started") {
        return {
          kind,
          summary,
          confidence,
          platform: parsedDecision.data.platform,
        };
      }

      if (kind === "code_edited") {
        return {
          kind,
          summary,
          confidence,
          workspaceHint: sanitizeForOptionalField(
            parsedDecision.data.workspaceHint,
            120,
          ),
          languageHint: sanitizeForOptionalField(
            parsedDecision.data.languageHint,
            40,
          ),
        };
      }

      const label = sanitizeForEmission(parsedDecision.data.label ?? "").slice(
        0,
        120,
      );
      if (!label) return null;
      return {
        kind: "task_detected",
        label,
        summary,
        confidence,
      };
    } catch (err) {
      log.debug({ err }, "perception interpretation failed");
      return null;
    }
  }

  private async publishInterpretedEvent(
    source: PerceptionEvent,
    inferred: InterpretedEmission,
  ): Promise<void> {
    if (!this.hub) return;
    const now = this.now();
    const eventPrefix =
      inferred.kind === "meeting_started"
        ? "meeting"
        : inferred.kind === "code_edited"
          ? "code"
          : "task";
    const payload = buildInterpretedPayload(source.eventId, inferred);
    const perception = {
      eventId: `${eventPrefix}-${source.eventId}-${now.getTime()}`,
      ts: now.toISOString(),
      source: { module: "assistant/perception-interpreter" },
      payload,
    };

    await this.hub.publish({
      id: perception.eventId,
      emittedAt: now.toISOString(),
      message: {
        type: perceptionEventType(payload.kind),
        perception,
      },
    } as never);
  }

  private shouldDebounce(
    event: PerceptionEvent & { payload: AppFocusChangedPayload },
  ): boolean {
    if (this.debounceMs <= 0) return false;
    const nowMs = this.now().getTime();
    const focusKey = `${event.payload.appId}|${event.payload.windowTitle}`;
    const priorMs = this.lastInterpretationByFocusKey.get(focusKey);
    this.lastInterpretationByFocusKey.set(focusKey, nowMs);

    if (priorMs == null) return false;
    return nowMs - priorMs < this.debounceMs;
  }
}

function buildInterpretedPayload(
  sourceEventId: string,
  inferred: InterpretedEmission,
) {
  if (inferred.kind === "meeting_started") {
    return {
      kind: "meeting_started" as const,
      summary: inferred.summary,
      confidence: inferred.confidence,
      sourceEventId,
      ...(inferred.platform ? { platform: inferred.platform } : {}),
    };
  }

  if (inferred.kind === "code_edited") {
    return {
      kind: "code_edited" as const,
      summary: inferred.summary,
      confidence: inferred.confidence,
      sourceEventId,
      ...(inferred.workspaceHint
        ? { workspaceHint: inferred.workspaceHint }
        : {}),
      ...(inferred.languageHint ? { languageHint: inferred.languageHint } : {}),
    };
  }

  return {
    kind: "task_detected" as const,
    label: inferred.label,
    summary: inferred.summary,
    confidence: inferred.confidence,
    sourceEventId,
  };
}

function parseJsonObjectFromText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // continue with fenced/object extraction fallback
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // ignore
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }
  throw new Error("missing JSON object");
}

function sanitizeForPrompt(value: string): string {
  return sanitizeText(value, 256);
}

function sanitizeForOptionalField(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  return sanitizeOptional(value, maxLength);
}

function sanitizeForEmission(value: string): string {
  return sanitizeText(value, 320);
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
