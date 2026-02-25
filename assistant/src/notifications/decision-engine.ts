/**
 * Notification decision engine.
 *
 * Evaluates a NotificationSignal against available channels and user
 * preferences, producing a NotificationDecision that tells the broadcaster
 * whether and how to notify the user. Uses the provider abstraction to
 * call the LLM with forced tool_choice output, falling back to a
 * deterministic heuristic when the model is unavailable or returns
 * invalid output.
 */

import { v4 as uuid } from 'uuid';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import { getConfiguredProvider, createTimeout, extractToolUse, userMessage } from '../providers/provider-send-message.js';
import { createDecision } from './decisions-store.js';
import { getPreferenceSummary } from './preference-summary.js';
import type { NotificationSignal } from './signal.js';
import type { NotificationChannel, NotificationDecision, RenderedChannelCopy } from './types.js';

const log = getLogger('notification-decision-engine');

const DECISION_TIMEOUT_MS = 15_000;
const PROMPT_VERSION = 'v1';

// ── System prompt ──────────────────────────────────────────────────────

function buildSystemPrompt(
  availableChannels: NotificationChannel[],
  preferenceContext?: string,
): string {
  const sections: string[] = [
    `You are a notification routing engine. Given a signal describing an event, decide whether the user should be notified, on which channel(s), and compose the notification copy.`,
    ``,
    `Available notification channels: ${availableChannels.join(', ')}`,
  ];

  if (preferenceContext) {
    sections.push(
      ``,
      `<user-preferences>`,
      preferenceContext,
      `</user-preferences>`,
    );
  }

  sections.push(
    ``,
    `Guidelines:`,
    `- Only notify when the signal genuinely warrants user attention.`,
    `- Prefer fewer channels unless the signal is urgent.`,
    `- For high-urgency signals that require action, notify on all available channels.`,
    `- For low-urgency background events, suppress unless they match user preferences.`,
    `- Keep notification copy concise and actionable.`,
    `- Generate a stable dedupeKey derived from the signal context so duplicate signals can be suppressed.`,
    ``,
    `You MUST respond using the \`record_notification_decision\` tool. Do not respond with text.`,
  );

  return sections.join('\n');
}

// ── User prompt ────────────────────────────────────────────────────────

function buildUserPrompt(signal: NotificationSignal): string {
  const parts: string[] = [
    `Signal ID: ${signal.signalId}`,
    `Source event: ${signal.sourceEventName}`,
    `Source channel: ${signal.sourceChannel}`,
    `Urgency: ${signal.attentionHints.urgency}`,
    `Requires action: ${signal.attentionHints.requiresAction}`,
    `Is async background: ${signal.attentionHints.isAsyncBackground}`,
    `User is viewing source now: ${signal.attentionHints.visibleInSourceNow}`,
  ];

  if (signal.attentionHints.deadlineAt) {
    parts.push(`Deadline: ${new Date(signal.attentionHints.deadlineAt).toISOString()}`);
  }

  const payloadStr = JSON.stringify(signal.contextPayload);
  if (payloadStr.length > 2) {
    parts.push(``, `Context payload:`, payloadStr);
  }

  return `Evaluate this notification signal:\n\n${parts.join('\n')}`;
}

// ── Tool definition ────────────────────────────────────────────────────

function buildDecisionTool(availableChannels: NotificationChannel[]) {
  return {
    name: 'record_notification_decision',
    description: 'Record the notification routing decision for this signal',
    input_schema: {
      type: 'object' as const,
      properties: {
        shouldNotify: {
          type: 'boolean',
          description: 'Whether the user should be notified about this signal',
        },
        selectedChannels: {
          type: 'array',
          items: {
            type: 'string',
            enum: availableChannels,
          },
          description: 'Which channels to deliver the notification on',
        },
        reasoningSummary: {
          type: 'string',
          description: 'Brief explanation of why this routing decision was made',
        },
        renderedCopy: {
          type: 'object',
          description: 'Notification copy keyed by channel name',
          properties: Object.fromEntries(
            availableChannels.map((ch) => [
              ch,
              {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Short notification title' },
                  body: { type: 'string', description: 'Notification body text' },
                  threadTitle: { type: 'string', description: 'Optional thread title for grouped notifications' },
                  threadSeedMessage: { type: 'string', description: 'Optional seed message for a new thread' },
                },
                required: ['title', 'body'],
              },
            ]),
          ),
        },
        deepLinkTarget: {
          type: 'object',
          description: 'Optional deep link metadata for navigating to the source context',
        },
        dedupeKey: {
          type: 'string',
          description: 'A stable key derived from the signal to deduplicate repeated notifications for the same event',
        },
        confidence: {
          type: 'number',
          description: 'Confidence in the decision (0.0-1.0)',
        },
      },
      required: ['shouldNotify', 'selectedChannels', 'reasoningSummary', 'renderedCopy', 'dedupeKey', 'confidence'],
    },
  };
}

// ── Deterministic fallback ─────────────────────────────────────────────

function buildFallbackDecision(
  signal: NotificationSignal,
  availableChannels: NotificationChannel[],
): NotificationDecision {
  const isHighUrgencyAction =
    signal.attentionHints.urgency === 'high' && signal.attentionHints.requiresAction;

  if (isHighUrgencyAction) {
    const copy: Partial<Record<NotificationChannel, RenderedChannelCopy>> = {};
    for (const ch of availableChannels) {
      copy[ch] = {
        title: signal.sourceEventName,
        body: `Action required: ${signal.sourceEventName}`,
      };
    }

    return {
      shouldNotify: true,
      selectedChannels: [...availableChannels],
      reasoningSummary: 'Fallback: high urgency + requires action',
      renderedCopy: copy,
      dedupeKey: `fallback:${signal.sourceEventName}:${signal.sourceSessionId}:${signal.createdAt}`,
      confidence: 0.3,
      fallbackUsed: true,
    };
  }

  return {
    shouldNotify: false,
    selectedChannels: [],
    reasoningSummary: 'Fallback: suppressed (not high urgency + requires action)',
    renderedCopy: {},
    dedupeKey: `fallback:${signal.sourceEventName}:${signal.sourceSessionId}:${signal.createdAt}`,
    confidence: 0.3,
    fallbackUsed: true,
  };
}

// ── Validation ─────────────────────────────────────────────────────────

const VALID_CHANNELS = new Set<string>(['vellum', 'telegram']);

function validateDecisionOutput(
  input: Record<string, unknown>,
  availableChannels: NotificationChannel[],
): NotificationDecision | null {
  if (typeof input.shouldNotify !== 'boolean') return null;
  if (typeof input.reasoningSummary !== 'string') return null;
  if (typeof input.dedupeKey !== 'string') return null;

  if (!Array.isArray(input.selectedChannels)) return null;
  const validatedChannels = (input.selectedChannels as unknown[]).filter(
    (ch): ch is NotificationChannel =>
      typeof ch === 'string' && VALID_CHANNELS.has(ch) && availableChannels.includes(ch as NotificationChannel),
  );
  const validChannels = [...new Set(validatedChannels)];

  const confidence = typeof input.confidence === 'number'
    ? Math.max(0, Math.min(1, input.confidence))
    : 0.5;

  // Validate renderedCopy
  const renderedCopy: Partial<Record<NotificationChannel, RenderedChannelCopy>> = {};
  if (input.renderedCopy && typeof input.renderedCopy === 'object') {
    const copyObj = input.renderedCopy as Record<string, unknown>;
    for (const ch of validChannels) {
      const chCopy = copyObj[ch];
      if (chCopy && typeof chCopy === 'object') {
        const c = chCopy as Record<string, unknown>;
        if (typeof c.title === 'string' && typeof c.body === 'string') {
          renderedCopy[ch] = {
            title: c.title,
            body: c.body,
            threadTitle: typeof c.threadTitle === 'string' ? c.threadTitle : undefined,
            threadSeedMessage: typeof c.threadSeedMessage === 'string' ? c.threadSeedMessage : undefined,
          };
        }
      }
    }
  }

  const deepLinkTarget = input.deepLinkTarget && typeof input.deepLinkTarget === 'object'
    ? input.deepLinkTarget as Record<string, unknown>
    : undefined;

  return {
    shouldNotify: input.shouldNotify,
    selectedChannels: validChannels,
    reasoningSummary: input.reasoningSummary,
    renderedCopy,
    deepLinkTarget,
    dedupeKey: input.dedupeKey,
    confidence,
    fallbackUsed: false,
  };
}

// ── Core evaluation function ───────────────────────────────────────────

export interface EvaluateSignalOptions {
  shadowMode?: boolean;
}

export async function evaluateSignal(
  signal: NotificationSignal,
  availableChannels: NotificationChannel[],
  preferenceContext?: string,
  options?: EvaluateSignalOptions,
): Promise<NotificationDecision> {
  const config = getConfig();
  const decisionModel = config.notifications.decisionModel;

  // When no explicit preference context is provided, load the user's
  // stored notification preferences from the memory-backed store.
  // Wrapped in try/catch so a DB failure doesn't break the decision path.
  let resolvedPreferenceContext = preferenceContext;
  if (resolvedPreferenceContext === undefined) {
    try {
      resolvedPreferenceContext = getPreferenceSummary(signal.assistantId) ?? undefined;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn({ err: errMsg, assistantId: signal.assistantId }, 'Failed to load preference summary, proceeding without preferences');
      resolvedPreferenceContext = undefined;
    }
  }

  const provider = getConfiguredProvider();
  if (!provider) {
    log.warn('Configured provider unavailable for notification decision, using fallback');
    const decision = buildFallbackDecision(signal, availableChannels);
    decision.persistedDecisionId = persistDecision(signal, decision);
    return decision;
  }

  let decision: NotificationDecision;
  try {
    decision = await classifyWithLLM(signal, availableChannels, resolvedPreferenceContext, decisionModel);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn({ err: errMsg }, 'Notification decision LLM call failed, using fallback');
    decision = buildFallbackDecision(signal, availableChannels);
  }

  decision.persistedDecisionId = persistDecision(signal, decision);

  if (options?.shadowMode ?? config.notifications.shadowMode) {
    log.info(
      {
        signalId: signal.signalId,
        shouldNotify: decision.shouldNotify,
        channels: decision.selectedChannels,
        fallbackUsed: decision.fallbackUsed,
        confidence: decision.confidence,
      },
      'Shadow mode: decision logged but not dispatched',
    );
  }

  return decision;
}

// ── LLM classification ────────────────────────────────────────────────

async function classifyWithLLM(
  signal: NotificationSignal,
  availableChannels: NotificationChannel[],
  preferenceContext: string | undefined,
  model: string,
): Promise<NotificationDecision> {
  const provider = getConfiguredProvider()!;
  const { signal: abortSignal, cleanup } = createTimeout(DECISION_TIMEOUT_MS);

  const systemPrompt = buildSystemPrompt(availableChannels, preferenceContext);
  const prompt = buildUserPrompt(signal);
  const tool = buildDecisionTool(availableChannels);

  try {
    const response = await provider.sendMessage(
      [userMessage(prompt)],
      [tool],
      systemPrompt,
      {
        config: {
          model,
          max_tokens: 2048,
          tool_choice: { type: 'tool' as const, name: 'record_notification_decision' },
        },
        signal: abortSignal,
      },
    );
    cleanup();

    const toolBlock = extractToolUse(response);
    if (!toolBlock) {
      log.warn('No tool_use block in notification decision response, using fallback');
      return buildFallbackDecision(signal, availableChannels);
    }

    const validated = validateDecisionOutput(
      toolBlock.input as Record<string, unknown>,
      availableChannels,
    );
    if (!validated) {
      log.warn('Invalid notification decision output from LLM, using fallback');
      return buildFallbackDecision(signal, availableChannels);
    }

    return validated;
  } finally {
    cleanup();
  }
}

// ── Persistence ────────────────────────────────────────────────────────

function persistDecision(signal: NotificationSignal, decision: NotificationDecision): string | undefined {
  try {
    const decisionId = uuid();
    createDecision({
      id: decisionId,
      notificationEventId: signal.signalId,
      shouldNotify: decision.shouldNotify,
      selectedChannels: decision.selectedChannels,
      reasoningSummary: decision.reasoningSummary,
      confidence: decision.confidence,
      fallbackUsed: decision.fallbackUsed,
      promptVersion: PROMPT_VERSION,
      validationResults: {
        dedupeKey: decision.dedupeKey,
        channelCount: decision.selectedChannels.length,
        hasCopy: Object.keys(decision.renderedCopy).length > 0,
      },
    });
    return decisionId;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn({ err: errMsg }, 'Failed to persist notification decision');
    return undefined;
  }
}
