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

import { getDeliverableChannels } from '../channels/config.js';
import { getConfig } from '../config/loader.js';
import { createTimeout, extractToolUse, getConfiguredProvider, userMessage } from '../providers/provider-send-message.js';
import type { ModelIntent } from '../providers/types.js';
import { getLogger } from '../util/logger.js';
import { createDecision } from './decisions-store.js';
import { getPreferenceSummary } from './preference-summary.js';
import type { NotificationSignal, RoutingIntent } from './signal.js';
import type { NotificationChannel, NotificationDecision, RenderedChannelCopy } from './types.js';

const log = getLogger('notification-decision-engine');

const DECISION_TIMEOUT_MS = 15_000;
const PROMPT_VERSION = 'v3';

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
    `- Generate a stable dedupeKey derived from the signal context so duplicate signals can be suppressed.`,
    ``,
    `Routing intent (when present in the signal):`,
    `- \`all_channels\`: The source explicitly requests notification on ALL connected channels.`,
    `- \`multi_channel\`: The source prefers 2+ channels when 2+ are connected.`,
    `- \`single_channel\`: Default routing behavior — use your best judgment (no override).`,
    `When a routing intent is present, respect it in your channel selection. A post-decision guard will enforce the intent.`,
    ``,
    `Copy guidelines (three distinct outputs):`,
    `- \`title\` and \`body\` are for native notification popups (e.g. vellum desktop/mobile) — keep them short and glanceable (title ≤ 8 words, body ≤ 2 sentences).`,
    `- \`deliveryText\` is the channel-native message for chat channels (e.g. telegram). It must read naturally as a standalone message.`,
    `  - Do not prepend mechanical labels like "Thread:".`,
    `  - Do not mention channel or transport names (e.g. Telegram, SMS, email) unless the event context explicitly requires it.`,
    `  - Do not repeat title/body verbatim unless that repetition is truly necessary.`,
    `  - Avoid meta-send phrasing (e.g. "I'd like to send a notification", "May I go ahead with that?"). Write the recipient-facing message directly.`,
    `  - For telegram: 1-2 concise sentences.`,
    `- \`threadSeedMessage\` is the opening message in the internal notification thread — it can be richer and more contextual.`,
    `  - For vellum (desktop): 2-4 short sentences with useful context and clear next step if action is required.`,
    `  - Never dump raw JSON. Include only human-readable context.`,
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

  if (signal.routingIntent && signal.routingIntent !== 'single_channel') {
    parts.push(`Routing intent: ${signal.routingIntent}`);
  }

  if (signal.routingHints && Object.keys(signal.routingHints).length > 0) {
    parts.push(`Routing hints: ${JSON.stringify(signal.routingHints)}`);
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
                  title: { type: 'string', description: 'Short notification popup title (≤ 8 words)' },
                  body: { type: 'string', description: 'Concise notification popup body (≤ 2 sentences)' },
                  deliveryText: { type: 'string', description: 'Channel-native chat message text (for example Telegram). Must stand alone naturally.' },
                  threadTitle: { type: 'string', description: 'Optional thread title for grouped notifications' },
                  threadSeedMessage: { type: 'string', description: 'Richer opening message for the notification thread. More contextual than title/body. For vellum: 2-4 sentences. For telegram: 1-2 sentences. Never raw JSON.' },
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

  // Always include the vellum channel in the fallback — it's a local IPC
  // broadcast with no cost, so desktop notifications should never be lost
  // when the LLM is unavailable. External channels (e.g. Telegram) are
  // only included for high-urgency actionable signals.
  const selectedChannels: NotificationChannel[] = isHighUrgencyAction
    ? [...availableChannels]
    : availableChannels.filter((ch) => ch === 'vellum');

  if (selectedChannels.length === 0) {
    return {
      shouldNotify: false,
      selectedChannels: [],
      reasoningSummary: 'Fallback: suppressed (vellum channel not available)',
      renderedCopy: {},
      dedupeKey: `fallback:${signal.sourceEventName}:${signal.sourceSessionId}:${signal.createdAt}`,
      confidence: 0.3,
      fallbackUsed: true,
    };
  }

  const copy: Partial<Record<NotificationChannel, RenderedChannelCopy>> = {};
  for (const ch of selectedChannels) {
    const fallbackBody = isHighUrgencyAction
      ? `Action required: ${signal.sourceEventName}`
      : signal.sourceEventName;
    copy[ch] = {
      title: signal.sourceEventName,
      body: fallbackBody,
      ...(ch === 'telegram' ? { deliveryText: fallbackBody } : {}),
    };
  }

  return {
    shouldNotify: true,
    selectedChannels,
    reasoningSummary: isHighUrgencyAction
      ? 'Fallback: high urgency + requires action — all channels'
      : 'Fallback: vellum-only (local IPC, always delivered)',
    renderedCopy: copy,
    dedupeKey: `fallback:${signal.sourceEventName}:${signal.sourceSessionId}:${signal.createdAt}`,
    confidence: 0.3,
    fallbackUsed: true,
  };
}

// ── Validation ─────────────────────────────────────────────────────────

const VALID_CHANNELS = new Set<string>(getDeliverableChannels());

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
          if (!c.title.trim() && !c.body.trim()) {
            log.warn({ channel: ch }, 'LLM returned empty title and body for channel copy — broadcaster will use fallback');
          }
          renderedCopy[ch] = {
            title: c.title,
            body: c.body,
            deliveryText: typeof c.deliveryText === 'string' ? c.deliveryText : undefined,
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

export async function evaluateSignal(
  signal: NotificationSignal,
  availableChannels: NotificationChannel[],
  preferenceContext?: string,
): Promise<NotificationDecision> {
  const config = getConfig();
  const decisionModelIntent = config.notifications.decisionModelIntent;

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
    decision = await classifyWithLLM(signal, availableChannels, resolvedPreferenceContext, decisionModelIntent);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn({ err: errMsg }, 'Notification decision LLM call failed, using fallback');
    decision = buildFallbackDecision(signal, availableChannels);
  }

  decision.persistedDecisionId = persistDecision(signal, decision);

  return decision;
}

// ── LLM classification ────────────────────────────────────────────────

async function classifyWithLLM(
  signal: NotificationSignal,
  availableChannels: NotificationChannel[],
  preferenceContext: string | undefined,
  modelIntent: ModelIntent,
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
          modelIntent,
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

// ── Post-decision routing intent enforcement ───────────────────────────

/**
 * Enforce routing intent policy on a decision after the LLM has produced it.
 * This is a fire-time guard: it overrides channel selection to match the
 * routing intent specified by the signal source (e.g. a reminder).
 *
 * - `all_channels`: force selected channels to all connected channels.
 * - `multi_channel`: ensure at least 2 channels when 2+ are connected.
 * - `single_channel`: no override (default behavior).
 */
export function enforceRoutingIntent(
  decision: NotificationDecision,
  routingIntent: RoutingIntent | undefined,
  connectedChannels: NotificationChannel[],
): NotificationDecision {
  if (!routingIntent || routingIntent === 'single_channel') {
    return decision;
  }

  if (!decision.shouldNotify) {
    return decision;
  }

  if (routingIntent === 'all_channels') {
    // Force all connected channels
    if (connectedChannels.length > 0) {
      const enforced = { ...decision };
      enforced.selectedChannels = [...connectedChannels];
      enforced.reasoningSummary = `${decision.reasoningSummary} [routing_intent=all_channels enforced: ${connectedChannels.join(', ')}]`;
      log.info(
        { routingIntent, connectedChannels, originalChannels: decision.selectedChannels },
        'Routing intent enforcement: all_channels → forced all connected channels',
      );
      return enforced;
    }
  }

  if (routingIntent === 'multi_channel') {
    // Ensure at least 2 channels when 2+ are connected
    if (connectedChannels.length >= 2 && decision.selectedChannels.length < 2) {
      const enforced = { ...decision };
      enforced.selectedChannels = [...connectedChannels];
      enforced.reasoningSummary = `${decision.reasoningSummary} [routing_intent=multi_channel enforced: expanded to ${connectedChannels.join(', ')}]`;
      log.info(
        { routingIntent, connectedChannels, originalChannels: decision.selectedChannels },
        'Routing intent enforcement: multi_channel → expanded to all connected channels',
      );
      return enforced;
    }
  }

  return decision;
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
