/**
 * HTTP route handlers for Twilio voice webhooks.
 *
 * - handleVoiceWebhook: initial voice webhook; returns TwiML to connect ConversationRelay
 * - handleStatusCallback: call status updates (ringing, in-progress, completed, etc.)
 * - handleConnectAction: called when the ConversationRelay connection ends
 */

import { getLogger } from '../util/logger.js';
import {
  getCallSession,
  getCallSessionByCallSid,
  updateCallSession,
  recordCallEvent,
  expirePendingQuestions,
  buildCallbackDedupeKey,
  claimCallback,
  releaseCallbackClaim,
  finalizeCallbackClaim,
} from './call-store.js';
import type { CallStatus } from './types.js';
import { logDeadLetterEvent } from './call-recovery.js';
import { isTerminalState } from './call-state-machine.js';
import { getTwilioConfig } from './twilio-config.js';
import { loadConfig } from '../config/loader.js';
import { getTwilioRelayUrl } from '../inbound/public-ingress-urls.js';
import { fireCallCompletionNotifier } from './call-state.js';
import { resolveVoiceQualityProfile, isVoiceProfileValid } from './voice-quality.js';

const log = getLogger('twilio-routes');

const CONTEXT_BLOCK_SPLIT_REGEX = /\n\s*\nContext:\s*/i;
const MAX_TASK_SUMMARY_CHARS = 90;
const MAX_TASK_SUMMARY_WORDS = 18;
const DEFAULT_WELCOME_GREETING = 'Hello, this is an assistant calling. Is now a good time to talk?';
const TASK_PREFIX_REGEX = /^task:\s*/i;
const UNSAFE_TASK_PATTERNS: RegExp[] = [
  /\byou are\b/i,
  /\b(system|assistant)\s+prompt\b/i,
  /\bimportant rules?\b/i,
  /\brespond naturally\b/i,
  /\bask_user\b/i,
  /\buser_answered\b/i,
  /\buser_instruction\b/i,
  /\bend_call\b/i,
  /\bcall_start\b/i,
  /\bllm\b/i,
  /\bclaude\b/i,
  /\bsay\s+(this|the following|exactly)\b/i,
];
const UNSAFE_TASK_CHARS_REGEX = /[<>{}\[\]`]/;

// ── Helpers ──────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generateTwiML(
  callSessionId: string,
  relayUrl: string,
  welcomeGreeting: string,
  profile: { language: string; transcriptionProvider: string; ttsProvider: string; voice: string },
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${escapeXml(relayUrl)}?callSessionId=${escapeXml(callSessionId)}"
      welcomeGreeting="${escapeXml(welcomeGreeting)}"
      voice="${escapeXml(profile.voice)}"
      language="${escapeXml(profile.language)}"
      transcriptionProvider="${escapeXml(profile.transcriptionProvider)}"
      ttsProvider="${escapeXml(profile.ttsProvider)}"
      interruptible="true"
      dtmfDetection="true"
    />
  </Connect>
</Response>`;
}

function summarizeTaskForGreeting(task: string | null): string | null {
  if (!task) return null;
  const primaryTaskBlock = task.split(CONTEXT_BLOCK_SPLIT_REGEX)[0]?.trim() ?? '';
  const primaryTaskLine = primaryTaskBlock
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  const primaryTask = primaryTaskLine.replace(TASK_PREFIX_REGEX, '').trim();
  if (!primaryTask) return null;

  const compact = primaryTask.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  if (!compact) return null;

  if (UNSAFE_TASK_CHARS_REGEX.test(compact)) return null;
  if (UNSAFE_TASK_PATTERNS.some((pattern) => pattern.test(compact))) return null;

  const wordCount = compact.split(/\s+/).length;
  if (wordCount > MAX_TASK_SUMMARY_WORDS) return null;

  if (compact.length <= MAX_TASK_SUMMARY_CHARS) return compact;
  return `${compact.slice(0, MAX_TASK_SUMMARY_CHARS - 3).trimEnd()}...`;
}

function formatTaskAsCallPurpose(taskSummary: string): string {
  const lower = taskSummary.toLowerCase();
  if (
    lower.startsWith('about ') ||
    lower.startsWith('to ') ||
    lower.startsWith('for ') ||
    lower.startsWith('regarding ')
  ) {
    return taskSummary;
  }
  return `about ${taskSummary}`;
}

export function buildWelcomeGreeting(task: string | null, configuredGreeting?: string): string {
  const override = configuredGreeting?.trim();
  if (override) return override;

  const taskSummary = summarizeTaskForGreeting(task);
  if (!taskSummary) return DEFAULT_WELCOME_GREETING;

  return `Hello, I am calling ${formatTaskAsCallPurpose(taskSummary)}. Is now a good time to talk?`;
}

/**
 * Resolve the WebSocket relay URL from Twilio config.
 *
 * Treats wssBaseUrl as present only when it is non-empty after trimming.
 * Falls back to webhookBaseUrl, normalizing the scheme from http(s) to ws(s)
 * and stripping any trailing slash.
 */
export function resolveRelayUrl(wssBaseUrl: string, webhookBaseUrl: string): string {
  const base = wssBaseUrl.trim() || webhookBaseUrl;
  const normalized = base.replace(/\/$/, '').replace(/^http(s?)/, 'ws$1');
  return `${normalized}/v1/calls/relay`;
}

/**
 * Map Twilio call status strings to our internal CallStatus.
 */
function mapTwilioStatus(twilioStatus: string): CallStatus | null {
  switch (twilioStatus) {
    case 'initiated':
    case 'queued':
      return 'initiated';
    case 'ringing':
      return 'ringing';
    case 'answered':
    case 'in-progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'busy':
    case 'no-answer':
    case 'canceled':
      return 'failed';
    default:
      return null;
  }
}

// ── Route handlers ───────────────────────────────────────────────────

/**
 * Receives the initial voice webhook when Twilio connects the call.
 * Returns TwiML XML that tells Twilio to open a ConversationRelay WebSocket.
 */
export async function handleVoiceWebhook(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const callSessionId = url.searchParams.get('callSessionId');

  if (!callSessionId) {
    log.warn('Voice webhook called without callSessionId');
    return new Response('Missing callSessionId', { status: 400 });
  }

  const session = getCallSession(callSessionId);
  if (!session) {
    log.warn({ callSessionId }, 'Voice webhook: call session not found');
    return new Response('Call session not found', { status: 404 });
  }

  if (isTerminalState(session.status)) {
    log.warn({ callSessionId, status: session.status }, 'Voice webhook: call session is in terminal state');
    return new Response('Call session is no longer active', { status: 410 });
  }

  // Parse the Twilio POST body to capture CallSid immediately, so status
  // callbacks (keyed by CallSid) can locate this session even if the
  // WebSocket relay hasn't been set up yet.
  const formBody = new URLSearchParams(await req.text());
  const callSid = formBody.get('CallSid');
  if (callSid && callSid !== session.providerCallSid) {
    updateCallSession(callSessionId, { providerCallSid: callSid });
    log.info({ callSessionId, callSid }, 'Stored CallSid from voice webhook');
  }

  let profile = resolveVoiceQualityProfile(loadConfig());

  log.info({ callSessionId, mode: profile.mode, ttsProvider: profile.ttsProvider, voice: profile.voice }, 'Voice quality profile resolved');

  if (profile.validationErrors.length > 0) {
    log.warn({ callSessionId, errors: profile.validationErrors }, 'Voice quality profile has validation warnings');
  }

  // WS-A: Enforce strict fallback semantics — reject invalid profiles when fallback is disabled
  if (!isVoiceProfileValid(profile)) {
    if (!profile.fallbackToStandardOnError) {
      const errorMsg = `Voice quality configuration error: ${profile.validationErrors.join('; ')}`;
      log.error({ callSessionId, errors: profile.validationErrors }, errorMsg);
      return new Response(errorMsg, { status: 500 });
    }
    // Fallback is enabled — profile already resolved to standard; log explicitly
    log.info({ callSessionId }, 'Profile invalid with fallback enabled; proceeding with standard mode');
  }

  // WS-B: Guard elevenlabs_agent until consultation bridge exists.
  // This fires BEFORE any ElevenLabs API calls, blocking the entire mode.
  if (profile.mode === 'elevenlabs_agent') {
    if (!profile.fallbackToStandardOnError) {
      const msg = 'elevenlabs_agent mode is restricted: consultation bridging (waiting_on_user) is not yet supported. Set calls.voice.fallbackToStandardOnError=true to fall back to standard mode.';
      log.error({ callSessionId }, msg);
      return new Response(msg, { status: 501 });
    }
    log.warn({ callSessionId }, 'elevenlabs_agent mode is restricted/experimental — consultation bridging is not yet supported; falling back to standard ConversationRelay TwiML');
    const standardConfig = loadConfig();
    profile = resolveVoiceQualityProfile({
      ...standardConfig,
      calls: {
        ...standardConfig.calls,
        voice: { ...standardConfig.calls.voice, mode: 'twilio_standard' },
      },
    });
  }

  const twilioConfig = getTwilioConfig(session.assistantId ?? undefined);
  let relayUrl: string;
  try {
    relayUrl = getTwilioRelayUrl(loadConfig());
  } catch {
    // Fallback to legacy resolution when ingress is not configured
    relayUrl = resolveRelayUrl(twilioConfig.wssBaseUrl, twilioConfig.webhookBaseUrl);
  }
  const welcomeGreeting = buildWelcomeGreeting(session.task, process.env.CALL_WELCOME_GREETING);

  const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, profile);

  log.info({ callSessionId }, 'Returning ConversationRelay TwiML');

  return new Response(twiml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

/**
 * Receives call status updates from Twilio (POST with form-urlencoded body).
 * Updates the call session status and records events.
 */
export async function handleStatusCallback(req: Request): Promise<Response> {
  const formBody = new URLSearchParams(await req.text());
  const callSid = formBody.get('CallSid');
  const callStatus = formBody.get('CallStatus');

  if (!callSid || !callStatus) {
    const rawPayload = Object.fromEntries(formBody.entries());
    logDeadLetterEvent('Status callback missing CallSid or CallStatus', rawPayload, log);
    return new Response(null, { status: 200 });
  }

  log.info({ callSid, callStatus }, 'Twilio status callback received');

  const session = getCallSessionByCallSid(callSid);
  if (!session) {
    log.warn({ callSid, callStatus }, 'Status callback: no call session found for CallSid');
    return new Response(null, { status: 200 });
  }

  const mappedStatus = mapTwilioStatus(callStatus);
  if (!mappedStatus) {
    const rawPayload = Object.fromEntries(formBody.entries());
    logDeadLetterEvent(`Unknown Twilio status: ${callStatus}`, rawPayload, log);
    return new Response(null, { status: 200 });
  }

  // ── Atomic idempotency claim ────────────────────────────────────
  const timestamp = formBody.get('Timestamp');
  const sequenceNumber = formBody.get('SequenceNumber');
  const dedupeKey = buildCallbackDedupeKey(callSid, callStatus, timestamp, sequenceNumber);

  const claimId = claimCallback(dedupeKey, session.id);
  if (!claimId) {
    log.info({ callSid, callStatus, dedupeKey }, 'Duplicate status callback — skipping');
    return new Response(null, { status: 200 });
  }

  try {
    const wasTerminal = isTerminalState(session.status);

    // Build updates
    const updates: Parameters<typeof updateCallSession>[1] = {
      status: mappedStatus,
    };

    if (mappedStatus === 'in_progress' && !session.startedAt) {
      updates.startedAt = Date.now();
    }

    const isTerminal = mappedStatus === 'completed' || mappedStatus === 'failed';
    if (isTerminal) {
      updates.endedAt = Date.now();
    }

    updateCallSession(session.id, updates);

    // Record event
    const eventType = isTerminal
      ? (mappedStatus === 'completed' ? 'call_ended' : 'call_failed')
      : (mappedStatus === 'in_progress' ? 'call_connected' : 'call_started');

    recordCallEvent(session.id, eventType, {
      twilioStatus: callStatus,
      callSid,
    });

    // Expire pending questions on terminal status
    if (isTerminal) {
      expirePendingQuestions(session.id);

      if (!wasTerminal) {
        fireCallCompletionNotifier(session.conversationId, session.id);
      }
    }

    // Mark the claim as permanently processed so it never expires.
    // If finalization returns false, another handler reclaimed this key
    // after our claim expired — our business writes already landed but
    // the dedupe row now belongs to the other handler, risking duplicate
    // processing on later retries.
    const finalized = finalizeCallbackClaim(dedupeKey, claimId);
    if (!finalized) {
      log.warn(
        { dedupeKey, claimId, callSid, callStatus },
        'Lost claim during finalization — business writes committed but dedupe ownership was taken by another handler',
      );
    }
  } catch (err) {
    // Release claim so Twilio retries can reprocess
    releaseCallbackClaim(dedupeKey, claimId);
    throw err;
  }

  return new Response(null, { status: 200 });
}

/**
 * Called when the ConversationRelay connection ends.
 * Returns empty TwiML to acknowledge.
 */
export async function handleConnectAction(_req: Request): Promise<Response> {
  log.info('ConversationRelay connect-action callback received');
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response/>',
    {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    },
  );
}
