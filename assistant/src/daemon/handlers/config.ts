import * as net from 'node:net';
import { getConfig, loadRawConfig, saveRawConfig } from '../../config/loader.js';
import { initializeProviders } from '../../providers/registry.js';
import { addRule, removeRule, updateRule, getAllRules, acceptStarterBundle } from '../../permissions/trust-store.js';
import { classifyRisk, check, generateAllowlistOptions, generateScopeOptions } from '../../permissions/checker.js';
import { isSideEffectTool } from '../../tools/executor.js';
import { resolveExecutionTarget, type ManifestOverride } from '../../tools/execution-target.js';
import { getAllTools, getTool } from '../../tools/registry.js';
import { loadSkillCatalog } from '../../config/skills.js';
import { parseToolManifestFile } from '../../skills/tool-manifest.js';
import { join } from 'node:path';
import { listSchedules, updateSchedule, deleteSchedule, describeCronExpression, getSchedule, createScheduleRun, completeScheduleRun } from '../../schedule/schedule-store.js';
import { createConversation } from '../../memory/conversation-store.js';
import { listReminders, cancelReminder } from '../../tools/reminder/reminder-store.js';
import { getSecureKey, setSecureKey, deleteSecureKey } from '../../security/secure-keys.js';
import { upsertCredentialMetadata, deleteCredentialMetadata, getCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import { postToSlackWebhook } from '../../slack/slack-webhook.js';
import { getApp } from '../../memory/app-store.js';
import * as externalConversationStore from '../../memory/external-conversation-store.js';
import { readHttpToken } from '../../util/platform.js';
import type {
  ModelSetRequest,
  ImageGenModelSetRequest,
  AddTrustRule,
  RemoveTrustRule,
  UpdateTrustRule,
  ScheduleToggle,
  ScheduleRemove,
  ScheduleRunNow,
  ReminderCancel,
  ShareToSlackRequest,
  SlackWebhookConfigRequest,
  IngressConfigRequest,
  VercelApiConfigRequest,
  TwitterIntegrationConfigRequest,
  TelegramConfigRequest,
  TwilioConfigRequest,
  ChannelReadinessRequest,
  GuardianVerificationRequest,
  ToolPermissionSimulateRequest,
} from '../ipc-protocol.js';
import {
  hasTwilioCredentials,
  listIncomingPhoneNumbers,
  searchAvailableNumbers,
  provisionPhoneNumber,
  updatePhoneNumberWebhooks,
  getTollFreeVerificationStatus,
  getTollFreeVerificationBySid,
  submitTollFreeVerification,
  updateTollFreeVerification,
  deleteTollFreeVerification,
  getPhoneNumberSid,
  releasePhoneNumber,
  fetchMessageStatus,
  type TollFreeVerificationSubmitParams,
} from '../../calls/twilio-rest.js';
import {
  getTwilioVoiceWebhookUrl,
  getTwilioStatusCallbackUrl,
  getTwilioSmsWebhookUrl,
  type IngressConfig,
} from '../../inbound/public-ingress-urls.js';
import { createVerificationChallenge, getGuardianBinding, revokeBinding as revokeGuardianBinding } from '../../runtime/channel-guardian-service.js';
import { createReadinessService, type ChannelReadinessService } from '../../runtime/channel-readiness-service.js';
import { log, CONFIG_RELOAD_DEBOUNCE_MS, defineHandlers, type HandlerContext } from './shared.js';
import { MODEL_TO_PROVIDER } from '../session-slash.js';

// Lazily capture the env-provided INGRESS_PUBLIC_BASE_URL on first access
// rather than at module load time. The daemon loads ~/.vellum/.env inside
// runDaemon() (see lifecycle.ts), which runs AFTER static ES module imports
// resolve. A module-level snapshot would miss dotenv-provided values.
let _originalIngressEnvCaptured = false;
let _originalIngressEnv: string | undefined;
function getOriginalIngressEnv(): string | undefined {
  if (!_originalIngressEnvCaptured) {
    _originalIngressEnv = process.env.INGRESS_PUBLIC_BASE_URL;
    _originalIngressEnvCaptured = true;
  }
  return _originalIngressEnv;
}

const TELEGRAM_BOT_TOKEN_IN_URL_PATTERN = /\/bot\d{8,10}:[A-Za-z0-9_-]{30,120}\//g;
const TELEGRAM_BOT_TOKEN_PATTERN = /(?<![A-Za-z0-9_])\d{8,10}:[A-Za-z0-9_-]{30,120}(?![A-Za-z0-9_])/g;

function redactTelegramBotTokens(value: string): string {
  return value
    .replace(TELEGRAM_BOT_TOKEN_IN_URL_PATTERN, '/bot[REDACTED]/')
    .replace(TELEGRAM_BOT_TOKEN_PATTERN, '[REDACTED]');
}

function summarizeTelegramError(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
  } else {
    parts.push(String(err));
  }
  const path = (err as { path?: unknown })?.path;
  if (typeof path === 'string' && path.length > 0) {
    parts.push(`path=${path}`);
  }
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && code.length > 0) {
    parts.push(`code=${code}`);
  }
  return redactTelegramBotTokens(parts.join(' '));
}

export function handleModelGet(socket: net.Socket, ctx: HandlerContext): void {
  const config = getConfig();
  const configured = Object.keys(config.apiKeys).filter((k) => !!config.apiKeys[k]);
  if (!configured.includes('ollama')) configured.push('ollama');
  ctx.send(socket, {
    type: 'model_info',
    model: config.model,
    provider: config.provider,
    configuredProviders: configured,
  });
}

export function handleModelSet(
  msg: ModelSetRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    // If the requested model is already the current model AND the provider
    // is already aligned with what MODEL_TO_PROVIDER expects, skip expensive
    // reinitialization but still send model_info so the client confirms.
    // If the provider has drifted (e.g. manual config edit), fall through
    // so the full reinit path can repair it.
    {
      const current = getConfig();
      const expectedProvider = MODEL_TO_PROVIDER[msg.model];
      const providerAligned = !expectedProvider || current.provider === expectedProvider;
      if (msg.model === current.model && providerAligned) {
        const configured = Object.keys(current.apiKeys).filter((k) => !!current.apiKeys[k]);
        if (!configured.includes('ollama')) configured.push('ollama');
        ctx.send(socket, {
          type: 'model_info',
          model: current.model,
          provider: current.provider,
          configuredProviders: configured,
        });
        return;
      }
    }

    // Validate API key before switching
    const provider = MODEL_TO_PROVIDER[msg.model];
    if (provider && provider !== 'ollama') {
      const currentConfig = getConfig();
      if (!currentConfig.apiKeys[provider]) {
        // Send current model_info so the client resyncs its optimistic state
        // (don't use generic 'error' type — it would interrupt in-flight chat)
        const configured = Object.keys(currentConfig.apiKeys).filter((k) => !!currentConfig.apiKeys[k]);
        if (!configured.includes('ollama')) configured.push('ollama');
        ctx.send(socket, { type: 'model_info', model: currentConfig.model, provider: currentConfig.provider, configuredProviders: configured });
        return;
      }
    }

    // Use raw config to avoid persisting env-var API keys to disk
    const raw = loadRawConfig();
    raw.model = msg.model;
    // Infer provider from model ID to keep provider and model in sync
    raw.provider = provider ?? raw.provider;

    // Suppress the file watcher callback — handleModelSet already does
    // the full reload sequence; a redundant watcher-triggered reload
    // would incorrectly evict sessions created after this method returns.
    const wasSuppressed = ctx.suppressConfigReload;
    ctx.setSuppressConfigReload(true);
    try {
      saveRawConfig(raw);
    } catch (err) {
      ctx.setSuppressConfigReload(wasSuppressed);
      throw err;
    }
    ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

    // Re-initialize provider with the new model so LLM calls use it
    const config = getConfig();
    initializeProviders(config);

    // Evict idle sessions immediately; mark busy ones as stale so they
    // get recreated with the new provider once they finish processing.
    for (const [id, session] of ctx.sessions) {
      if (!session.isProcessing()) {
        session.dispose();
        ctx.sessions.delete(id);
      } else {
        session.markStale();
      }
    }

    ctx.updateConfigFingerprint();

    ctx.send(socket, {
      type: 'model_info',
      model: config.model,
      provider: config.provider,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.send(socket, { type: 'error', message: `Failed to set model: ${message}` });
  }
}

export function handleImageGenModelSet(
  msg: ImageGenModelSetRequest,
  _socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const raw = loadRawConfig();
    raw.imageGenModel = msg.model;

    const wasSuppressed = ctx.suppressConfigReload;
    ctx.setSuppressConfigReload(true);
    try {
      saveRawConfig(raw);
    } catch (err) {
      ctx.setSuppressConfigReload(wasSuppressed);
      throw err;
    }
    ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

    ctx.updateConfigFingerprint();
    log.info({ model: msg.model }, 'Image generation model updated');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, `Failed to set image gen model: ${message}`);
  }
}

export function handleAddTrustRule(
  msg: AddTrustRule,
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  try {
    const hasMetadata = msg.allowHighRisk != null
      || msg.executionTarget != null;

    addRule(
      msg.toolName,
      msg.pattern,
      msg.scope,
      msg.decision,
      undefined, // priority — use default
      hasMetadata
        ? {
            allowHighRisk: msg.allowHighRisk,
            executionTarget: msg.executionTarget,
          }
        : undefined,
    );
    log.info({ toolName: msg.toolName, pattern: msg.pattern, scope: msg.scope, decision: msg.decision }, 'Trust rule added via client');
  } catch (err) {
    log.error({ err, toolName: msg.toolName, pattern: msg.pattern, scope: msg.scope }, 'Failed to add trust rule via client');
  }
}

export function handleTrustRulesList(socket: net.Socket, ctx: HandlerContext): void {
  const rules = getAllRules();
  ctx.send(socket, { type: 'trust_rules_list_response', rules });
}

export function handleRemoveTrustRule(
  msg: RemoveTrustRule,
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  try {
    const removed = removeRule(msg.id);
    if (!removed) {
      log.warn({ id: msg.id }, 'Trust rule not found for removal');
    } else {
      log.info({ id: msg.id }, 'Trust rule removed via client');
    }
  } catch (err) {
    log.error({ err }, 'Failed to remove trust rule');
  }
}

export function handleUpdateTrustRule(
  msg: UpdateTrustRule,
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  try {
    updateRule(msg.id, {
      tool: msg.tool,
      pattern: msg.pattern,
      scope: msg.scope,
      decision: msg.decision,
      priority: msg.priority,
    });
    log.info({ id: msg.id }, 'Trust rule updated via client');
  } catch (err) {
    log.error({ err }, 'Failed to update trust rule');
  }
}

export function handleAcceptStarterBundle(
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const result = acceptStarterBundle();
    ctx.send(socket, {
      type: 'accept_starter_bundle_response',
      accepted: result.accepted,
      rulesAdded: result.rulesAdded,
      alreadyAccepted: result.alreadyAccepted,
    });
    log.info({ rulesAdded: result.rulesAdded, alreadyAccepted: result.alreadyAccepted }, 'Starter bundle accepted via client');
  } catch (err) {
    log.error({ err }, 'Failed to accept starter bundle');
    ctx.send(socket, { type: 'error', message: 'Failed to accept starter bundle' });
  }
}

export function handleSchedulesList(socket: net.Socket, ctx: HandlerContext): void {
  const jobs = listSchedules();
  ctx.send(socket, {
    type: 'schedules_list_response',
    schedules: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      syntax: j.syntax,
      expression: j.expression,
      cronExpression: j.cronExpression,
      timezone: j.timezone,
      message: j.message,
      nextRunAt: j.nextRunAt,
      lastRunAt: j.lastRunAt,
      lastStatus: j.lastStatus,
      description: j.syntax === 'cron' ? describeCronExpression(j.cronExpression) : j.expression,
    })),
  });
}

export function handleScheduleToggle(
  msg: ScheduleToggle,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    updateSchedule(msg.id, { enabled: msg.enabled });
    log.info({ id: msg.id, enabled: msg.enabled }, 'Schedule toggled via client');
  } catch (err) {
    log.error({ err }, 'Failed to toggle schedule');
  }
  handleSchedulesList(socket, ctx);
}

export function handleScheduleRemove(
  msg: ScheduleRemove,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const removed = deleteSchedule(msg.id);
    if (!removed) {
      log.warn({ id: msg.id }, 'Schedule not found for removal');
    } else {
      log.info({ id: msg.id }, 'Schedule removed via client');
    }
  } catch (err) {
    log.error({ err }, 'Failed to remove schedule');
  }
  handleSchedulesList(socket, ctx);
}

export async function handleScheduleRunNow(
  msg: ScheduleRunNow,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const schedule = getSchedule(msg.id);
  if (!schedule) {
    log.warn({ id: msg.id }, 'Schedule not found for run-now');
    return;
  }

  const conversation = createConversation(`Schedule (manual): ${schedule.name}`);
  const runId = createScheduleRun(schedule.id, conversation.id);

  try {
    log.info({ jobId: schedule.id, name: schedule.name, conversationId: conversation.id }, 'Executing schedule manually (run now)');
    const session = await ctx.getOrCreateSession(conversation.id, socket, true);
    await session.processMessage(schedule.message, [], (event) => {
      ctx.send(socket, event);
    });
    completeScheduleRun(runId, { status: 'ok' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, jobId: schedule.id, name: schedule.name }, 'Manual schedule execution failed');
    completeScheduleRun(runId, { status: 'error', error: message });
  }
  handleSchedulesList(socket, ctx);
}

export function handleRemindersList(socket: net.Socket, ctx: HandlerContext): void {
  const items = listReminders();
  ctx.send(socket, {
    type: 'reminders_list_response',
    reminders: items.map((r) => ({
      id: r.id,
      label: r.label,
      message: r.message,
      fireAt: r.fireAt,
      mode: r.mode,
      status: r.status,
      firedAt: r.firedAt,
      createdAt: r.createdAt,
    })),
  });
}

export function handleReminderCancel(
  msg: ReminderCancel,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const cancelled = cancelReminder(msg.id);
    if (!cancelled) {
      log.warn({ id: msg.id }, 'Reminder not found or already fired/cancelled');
    } else {
      log.info({ id: msg.id }, 'Reminder cancelled via client');
    }
  } catch (err) {
    log.error({ err }, 'Failed to cancel reminder');
  }
  handleRemindersList(socket, ctx);
}

export async function handleShareToSlack(
  msg: ShareToSlackRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const config = loadRawConfig();
    const webhookUrl = config.slackWebhookUrl as string | undefined;
    if (!webhookUrl) {
      ctx.send(socket, {
        type: 'share_to_slack_response',
        success: false,
        error: 'No Slack webhook URL configured. Provide one here in the chat, or set it from the Settings page.',
      });
      return;
    }

    const app = getApp(msg.appId);
    if (!app) {
      ctx.send(socket, {
        type: 'share_to_slack_response',
        success: false,
        error: `App not found: ${msg.appId}`,
      });
      return;
    }

    await postToSlackWebhook(
      webhookUrl,
      app.name,
      app.description ?? '',
      '\u{1F4F1}',
    );

    ctx.send(socket, { type: 'share_to_slack_response', success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appId: msg.appId }, 'Failed to share app to Slack');
    ctx.send(socket, {
      type: 'share_to_slack_response',
      success: false,
      error: message,
    });
  }
}

export function handleSlackWebhookConfig(
  msg: SlackWebhookConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const config = loadRawConfig();
    if (msg.action === 'get') {
      ctx.send(socket, {
        type: 'slack_webhook_config_response',
        webhookUrl: (config.slackWebhookUrl as string) ?? undefined,
        success: true,
      });
    } else {
      config.slackWebhookUrl = msg.webhookUrl ?? '';
      saveRawConfig(config);
      ctx.send(socket, {
        type: 'slack_webhook_config_response',
        success: true,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle Slack webhook config');
    ctx.send(socket, {
      type: 'slack_webhook_config_response',
      success: false,
      error: message,
    });
  }
}

function computeGatewayTarget(): string {
  if (process.env.GATEWAY_INTERNAL_BASE_URL) {
    return process.env.GATEWAY_INTERNAL_BASE_URL.replace(/\/+$/, '');
  }
  const portRaw = process.env.GATEWAY_PORT || '7830';
  const port = Number(portRaw) || 7830;
  return `http://127.0.0.1:${port}`;
}

/**
 * Best-effort call to the gateway's internal reconcile endpoint so that
 * Telegram webhook registration is updated immediately when the ingress
 * URL changes, without requiring a gateway restart.
 */
function triggerGatewayReconcile(ingressPublicBaseUrl: string | undefined): void {
  const gatewayBase = computeGatewayTarget();
  const token = readHttpToken();
  if (!token) {
    log.debug('Skipping gateway reconcile trigger: no HTTP bearer token available');
    return;
  }

  const url = `${gatewayBase}/internal/telegram/reconcile`;
  const body = JSON.stringify({ ingressPublicBaseUrl: ingressPublicBaseUrl ?? '' });

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body,
    signal: AbortSignal.timeout(5_000),
  }).then((res) => {
    if (res.ok) {
      log.info('Gateway Telegram webhook reconcile triggered successfully');
    } else {
      log.warn({ status: res.status }, 'Gateway Telegram webhook reconcile returned non-OK status');
    }
  }).catch((err) => {
    log.debug({ err }, 'Gateway Telegram webhook reconcile failed (gateway may not be running)');
  });
}

/**
 * Best-effort Twilio webhook sync helper.
 *
 * Computes the voice, status-callback, and SMS webhook URLs from the current
 * ingress config and pushes them to the Twilio IncomingPhoneNumber API.
 *
 * Returns `{ success, warning }`. When the update fails, `success` is false
 * and `warning` contains a human-readable message. Callers should treat
 * failure as non-fatal so that the primary operation (provision, assign,
 * ingress save) still succeeds.
 */
async function syncTwilioWebhooks(
  phoneNumber: string,
  accountSid: string,
  authToken: string,
  ingressConfig: IngressConfig,
): Promise<{ success: boolean; warning?: string }> {
  try {
    const voiceUrl = getTwilioVoiceWebhookUrl(ingressConfig);
    const statusCallbackUrl = getTwilioStatusCallbackUrl(ingressConfig);
    const smsUrl = getTwilioSmsWebhookUrl(ingressConfig);
    await updatePhoneNumberWebhooks(accountSid, authToken, phoneNumber, {
      voiceUrl,
      statusCallbackUrl,
      smsUrl,
    });
    log.info({ phoneNumber }, 'Twilio webhooks configured successfully');
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, phoneNumber }, `Webhook configuration skipped: ${message}`);
    return { success: false, warning: `Webhook configuration skipped: ${message}` };
  }
}

export async function handleIngressConfig(
  msg: IngressConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const localGatewayTarget = computeGatewayTarget();
  try {
    if (msg.action === 'get') {
      const raw = loadRawConfig();
      const ingress = (raw?.ingress ?? {}) as Record<string, unknown>;
      const publicBaseUrl = (ingress.publicBaseUrl as string) ?? '';
      // Backward compatibility: if `enabled` was never explicitly set,
      // infer from whether a publicBaseUrl is configured so existing users
      // who predate the toggle aren't silently disabled.
      const enabled = (ingress.enabled as boolean | undefined) ?? (publicBaseUrl ? true : false);
      ctx.send(socket, { type: 'ingress_config_response', enabled, publicBaseUrl, localGatewayTarget, success: true });
    } else if (msg.action === 'set') {
      const value = (msg.publicBaseUrl ?? '').trim().replace(/\/+$/, '');
      // Ensure we capture the original env value before any mutation below
      getOriginalIngressEnv();
      const raw = loadRawConfig();

      // Update ingress.publicBaseUrl — this is the single source of truth for
      // the canonical public ingress URL. The gateway receives this value via
      // the INGRESS_PUBLIC_BASE_URL env var at spawn time (see hatch.ts).
      // The gateway also validates Twilio signatures against forwarded public
      // URL headers, so local tunnel updates generally apply without restarts.
      const ingress = (raw?.ingress ?? {}) as Record<string, unknown>;
      ingress.publicBaseUrl = value || undefined;
      if (msg.enabled !== undefined) {
        ingress.enabled = msg.enabled;
      }

      const wasSuppressed = ctx.suppressConfigReload;
      ctx.setSuppressConfigReload(true);
      try {
        saveRawConfig({ ...raw, ingress });
      } catch (err) {
        ctx.setSuppressConfigReload(wasSuppressed);
        throw err;
      }
      ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

      // Propagate to the gateway's process environment so it picks up the
      // new URL when it is restarted. For the local-deployment path the
      // gateway runs as a child process that inherited the assistant's env,
      // so updating process.env here ensures the value is visible when the
      // gateway is restarted (e.g. by the self-upgrade skill or a manual
      // `pkill -f gateway`).
      // Only export the URL when ingress is enabled; clearing it when
      // disabled ensures the gateway stops accepting inbound webhooks.
      const isEnabled = (ingress.enabled as boolean | undefined) ?? (value ? true : false);
      if (value && isEnabled) {
        process.env.INGRESS_PUBLIC_BASE_URL = value;
      } else if (isEnabled && getOriginalIngressEnv() !== undefined) {
        // Ingress is enabled but the user cleared the URL — fall back to the
        // env var that was present when the process started.
        process.env.INGRESS_PUBLIC_BASE_URL = getOriginalIngressEnv()!;
      } else {
        // Ingress is disabled or no URL is configured and no startup env var
        // exists — remove the env var so the gateway stops accepting webhooks.
        delete process.env.INGRESS_PUBLIC_BASE_URL;
      }

      ctx.send(socket, { type: 'ingress_config_response', enabled: isEnabled, publicBaseUrl: value, localGatewayTarget, success: true });

      // Trigger immediate Telegram webhook reconcile on the gateway so
      // that changing the ingress URL takes effect without a restart.
      // Called unconditionally so the gateway clears its in-memory URL
      // when ingress is disabled, preventing stale re-registration on
      // credential rotation.
      // Use the effective URL from process.env (which accounts for the
      // fallback branch above) rather than the raw `value` from the UI.
      const effectiveUrl = isEnabled ? process.env.INGRESS_PUBLIC_BASE_URL : undefined;
      triggerGatewayReconcile(effectiveUrl);

      // Best-effort Twilio webhook reconciliation: when ingress is being
      // enabled/updated and Twilio numbers are assigned with valid credentials,
      // push the new webhook URLs to Twilio so calls and SMS route correctly.
      if (isEnabled && hasTwilioCredentials()) {
        const currentConfig = loadRawConfig();
        const smsConfig = (currentConfig?.sms ?? {}) as Record<string, unknown>;
        const assignedNumbers = new Set<string>();
        const legacyNumber = (smsConfig.phoneNumber as string) ?? '';
        if (legacyNumber) assignedNumbers.add(legacyNumber);

        const assistantPhoneNumbers = smsConfig.assistantPhoneNumbers;
        if (assistantPhoneNumbers && typeof assistantPhoneNumbers === 'object' && !Array.isArray(assistantPhoneNumbers)) {
          for (const number of Object.values(assistantPhoneNumbers as Record<string, unknown>)) {
            if (typeof number === 'string' && number) {
              assignedNumbers.add(number);
            }
          }
        }

        if (assignedNumbers.size > 0) {
          const acctSid = getSecureKey('credential:twilio:account_sid')!;
          const acctToken = getSecureKey('credential:twilio:auth_token')!;
          // Fire-and-forget: webhook sync failure must not block the ingress save.
          // Reconcile every assigned number so assistant-scoped mappings do not
          // retain stale Twilio webhook URLs after ingress URL changes.
          for (const assignedNumber of assignedNumbers) {
            syncTwilioWebhooks(assignedNumber, acctSid, acctToken, currentConfig as IngressConfig)
              .catch(() => {
                // Already logged inside syncTwilioWebhooks
              });
          }
        }
      }
    } else {
      ctx.send(socket, { type: 'ingress_config_response', enabled: false, publicBaseUrl: '', localGatewayTarget, success: false, error: `Unknown action: ${String((msg as unknown as Record<string, unknown>).action)}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.send(socket, { type: 'ingress_config_response', enabled: false, publicBaseUrl: '', localGatewayTarget, success: false, error: message });
  }
}

export function handleVercelApiConfig(
  msg: VercelApiConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    if (msg.action === 'get') {
      const existing = getSecureKey('credential:vercel:api_token');
      ctx.send(socket, {
        type: 'vercel_api_config_response',
        hasToken: !!existing,
        success: true,
      });
    } else if (msg.action === 'set') {
      if (!msg.apiToken) {
        ctx.send(socket, {
          type: 'vercel_api_config_response',
          hasToken: false,
          success: false,
          error: 'apiToken is required for set action',
        });
        return;
      }
      const stored = setSecureKey('credential:vercel:api_token', msg.apiToken);
      if (!stored) {
        ctx.send(socket, {
          type: 'vercel_api_config_response',
          hasToken: false,
          success: false,
          error: 'Failed to store API token in secure storage',
        });
        return;
      }
      upsertCredentialMetadata('vercel', 'api_token', {
        allowedTools: ['publish_page', 'unpublish_page'],
      });
      ctx.send(socket, {
        type: 'vercel_api_config_response',
        hasToken: true,
        success: true,
      });
    } else {
      deleteSecureKey('credential:vercel:api_token');
      deleteCredentialMetadata('vercel', 'api_token');
      ctx.send(socket, {
        type: 'vercel_api_config_response',
        hasToken: false,
        success: true,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle Vercel API config');
    ctx.send(socket, {
      type: 'vercel_api_config_response',
      hasToken: false,
      success: false,
      error: message,
    });
  }
}

export function handleTwitterIntegrationConfig(
  msg: TwitterIntegrationConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    if (msg.action === 'get') {
      const raw = loadRawConfig();
      const mode = (raw.twitterIntegrationMode as 'local_byo' | 'managed' | undefined) ?? 'local_byo';
      const strategy = (raw.twitterOperationStrategy as 'oauth' | 'browser' | 'auto' | undefined) ?? 'auto';
      const strategyConfigured = Object.prototype.hasOwnProperty.call(raw, 'twitterOperationStrategy');
      const localClientConfigured = !!getSecureKey('credential:integration:twitter:oauth_client_id');
      const connected = !!getSecureKey('credential:integration:twitter:access_token');
      const meta = getCredentialMetadata('integration:twitter', 'access_token');
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        mode,
        managedAvailable: false,
        localClientConfigured,
        connected,
        accountInfo: meta?.accountInfo ?? undefined,
        strategy,
        strategyConfigured,
      });
    } else if (msg.action === 'get_strategy') {
      const raw = loadRawConfig();
      const strategy = (raw.twitterOperationStrategy as 'oauth' | 'browser' | 'auto' | undefined) ?? 'auto';
      const strategyConfigured = Object.prototype.hasOwnProperty.call(raw, 'twitterOperationStrategy');
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        managedAvailable: false,
        localClientConfigured: !!getSecureKey('credential:integration:twitter:oauth_client_id'),
        connected: !!getSecureKey('credential:integration:twitter:access_token'),
        strategy,
        strategyConfigured,
      });
    } else if (msg.action === 'set_strategy') {
      const valid = ['oauth', 'browser', 'auto'];
      const value = msg.strategy;
      if (!value || !valid.includes(value)) {
        ctx.send(socket, {
          type: 'twitter_integration_config_response',
          success: false,
          managedAvailable: false,
          localClientConfigured: false,
          connected: false,
          error: `Invalid strategy value: ${String(value)}. Must be one of: ${valid.join(', ')}`,
        });
        return;
      }
      const raw = loadRawConfig();
      raw.twitterOperationStrategy = value;
      saveRawConfig(raw);
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        managedAvailable: false,
        localClientConfigured: !!getSecureKey('credential:integration:twitter:oauth_client_id'),
        connected: !!getSecureKey('credential:integration:twitter:access_token'),
        strategy: value as 'oauth' | 'browser' | 'auto',
        strategyConfigured: true,
      });
    } else if (msg.action === 'set_mode') {
      const raw = loadRawConfig();
      raw.twitterIntegrationMode = msg.mode ?? 'local_byo';
      saveRawConfig(raw);
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        mode: msg.mode ?? 'local_byo',
        managedAvailable: false,
        localClientConfigured: !!getSecureKey('credential:integration:twitter:oauth_client_id'),
        connected: !!getSecureKey('credential:integration:twitter:access_token'),
      });
    } else if (msg.action === 'set_local_client') {
      if (!msg.clientId) {
        ctx.send(socket, {
          type: 'twitter_integration_config_response',
          success: false,
          managedAvailable: false,
          localClientConfigured: false,
          connected: false,
          error: 'clientId is required for set_local_client action',
        });
        return;
      }
      const previousClientId = getSecureKey('credential:integration:twitter:oauth_client_id');
      const storedId = setSecureKey('credential:integration:twitter:oauth_client_id', msg.clientId);
      if (!storedId) {
        ctx.send(socket, {
          type: 'twitter_integration_config_response',
          success: false,
          managedAvailable: false,
          localClientConfigured: false,
          connected: false,
          error: 'Failed to store client ID in secure storage',
        });
        return;
      }
      if (msg.clientSecret) {
        const storedSecret = setSecureKey('credential:integration:twitter:oauth_client_secret', msg.clientSecret);
        if (!storedSecret) {
          // Roll back the client ID to its previous value to avoid inconsistent OAuth state
          if (previousClientId) {
            setSecureKey('credential:integration:twitter:oauth_client_id', previousClientId);
          } else {
            deleteSecureKey('credential:integration:twitter:oauth_client_id');
          }
          ctx.send(socket, {
            type: 'twitter_integration_config_response',
            success: false,
            managedAvailable: false,
            localClientConfigured: !!previousClientId,
            connected: false,
            error: 'Failed to store client secret in secure storage',
          });
          return;
        }
      } else {
        // Clear any stale secret when updating client without a secret (e.g. switching to PKCE)
        deleteSecureKey('credential:integration:twitter:oauth_client_secret');
      }
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        managedAvailable: false,
        localClientConfigured: true,
        connected: !!getSecureKey('credential:integration:twitter:access_token'),
      });
    } else if (msg.action === 'clear_local_client') {
      // If connected, disconnect first
      if (getSecureKey('credential:integration:twitter:access_token')) {
        deleteSecureKey('credential:integration:twitter:access_token');
        deleteSecureKey('credential:integration:twitter:refresh_token');
        deleteCredentialMetadata('integration:twitter', 'access_token');
      }
      deleteSecureKey('credential:integration:twitter:oauth_client_id');
      deleteSecureKey('credential:integration:twitter:oauth_client_secret');
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        managedAvailable: false,
        localClientConfigured: false,
        connected: false,
      });
    } else if (msg.action === 'disconnect') {
      deleteSecureKey('credential:integration:twitter:access_token');
      deleteSecureKey('credential:integration:twitter:refresh_token');
      deleteCredentialMetadata('integration:twitter', 'access_token');
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        managedAvailable: false,
        localClientConfigured: !!getSecureKey('credential:integration:twitter:oauth_client_id'),
        connected: false,
      });
    } else {
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: false,
        managedAvailable: false,
        localClientConfigured: false,
        connected: false,
        error: `Unknown action: ${String((msg as unknown as Record<string, unknown>).action)}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle Twitter integration config');
    ctx.send(socket, {
      type: 'twitter_integration_config_response',
      success: false,
      managedAvailable: false,
      localClientConfigured: false,
      connected: false,
      error: message,
    });
  }
}

export async function handleTelegramConfig(
  msg: TelegramConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    if (msg.action === 'get') {
      const hasBotToken = !!getSecureKey('credential:telegram:bot_token');
      const hasWebhookSecret = !!getSecureKey('credential:telegram:webhook_secret');
      const meta = getCredentialMetadata('telegram', 'bot_token');
      const botUsername = meta?.accountInfo ?? undefined;
      ctx.send(socket, {
        type: 'telegram_config_response',
        success: true,
        hasBotToken,
        botUsername,
        connected: hasBotToken && hasWebhookSecret,
        hasWebhookSecret,
      });
    } else if (msg.action === 'set') {
      // Resolve token: prefer explicit msg.botToken, fall back to secure storage.
      // Track provenance so we only rollback tokens that were freshly provided.
      const isNewToken = !!msg.botToken;
      const botToken = msg.botToken || getSecureKey('credential:telegram:bot_token');
      if (!botToken) {
        ctx.send(socket, {
          type: 'telegram_config_response',
          success: false,
          hasBotToken: false,
          connected: false,
          hasWebhookSecret: false,
          error: 'botToken is required for set action',
        });
        return;
      }

      // Validate token via Telegram getMe API
      let botUsername: string;
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
        if (!res.ok) {
          const body = await res.text();
          ctx.send(socket, {
            type: 'telegram_config_response',
            success: false,
            hasBotToken: false,
            connected: false,
            hasWebhookSecret: false,
            error: `Telegram API validation failed: ${body}`,
          });
          return;
        }
        const data = await res.json() as { ok: boolean; result?: { username?: string } };
        if (!data.ok || !data.result?.username) {
          ctx.send(socket, {
            type: 'telegram_config_response',
            success: false,
            hasBotToken: false,
            connected: false,
            hasWebhookSecret: false,
            error: 'Telegram API returned unexpected response',
          });
          return;
        }
        botUsername = data.result.username;
      } catch (err) {
        const message = summarizeTelegramError(err);
        ctx.send(socket, {
          type: 'telegram_config_response',
          success: false,
          hasBotToken: false,
          connected: false,
          hasWebhookSecret: false,
          error: `Failed to validate bot token: ${message}`,
        });
        return;
      }

      // Store bot token securely
      const stored = setSecureKey('credential:telegram:bot_token', botToken);
      if (!stored) {
        ctx.send(socket, {
          type: 'telegram_config_response',
          success: false,
          hasBotToken: false,
          connected: false,
          hasWebhookSecret: false,
          error: 'Failed to store bot token in secure storage',
        });
        return;
      }

      // Store metadata with bot username
      upsertCredentialMetadata('telegram', 'bot_token', {
        accountInfo: botUsername,
      });

      // Ensure webhook secret exists (generate if missing)
      let hasWebhookSecret = !!getSecureKey('credential:telegram:webhook_secret');
      if (!hasWebhookSecret) {
        const { randomUUID } = await import('node:crypto');
        const webhookSecret = randomUUID();
        const secretStored = setSecureKey('credential:telegram:webhook_secret', webhookSecret);
        if (secretStored) {
          upsertCredentialMetadata('telegram', 'webhook_secret', {});
          hasWebhookSecret = true;
        } else {
          // Only roll back the bot token if it was freshly provided.
          // When the token came from secure storage it was already valid
          // configuration; deleting it would destroy working state.
          if (isNewToken) {
            deleteSecureKey('credential:telegram:bot_token');
            deleteCredentialMetadata('telegram', 'bot_token');
          }
          ctx.send(socket, {
            type: 'telegram_config_response',
            success: false,
            hasBotToken: !isNewToken,
            connected: false,
            hasWebhookSecret: false,
            error: 'Failed to store webhook secret',
          });
          return;
        }
      } else {
        // Self-heal: ensure metadata exists even when the secret was
        // already present (covers previously lost/corrupted metadata).
        upsertCredentialMetadata('telegram', 'webhook_secret', {});
      }

      ctx.send(socket, {
        type: 'telegram_config_response',
        success: true,
        hasBotToken: true,
        botUsername,
        connected: true,
        hasWebhookSecret,
      });

      // Trigger gateway reconcile so the webhook registration updates immediately
      const effectiveUrl = process.env.INGRESS_PUBLIC_BASE_URL;
      if (effectiveUrl) {
        triggerGatewayReconcile(effectiveUrl);
      }
    } else if (msg.action === 'clear') {
      // Deregister the Telegram webhook before deleting credentials.
      // The gateway reconcile short-circuits when credentials are absent,
      // so we must call the Telegram API directly while the token is still
      // available.
      const botToken = getSecureKey('credential:telegram:bot_token');
      if (botToken) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`);
        } catch (err) {
          log.warn(
            { error: summarizeTelegramError(err) },
            'Failed to deregister Telegram webhook (proceeding with credential cleanup)',
          );
        }
      }

      deleteSecureKey('credential:telegram:bot_token');
      deleteCredentialMetadata('telegram', 'bot_token');
      deleteSecureKey('credential:telegram:webhook_secret');
      deleteCredentialMetadata('telegram', 'webhook_secret');

      ctx.send(socket, {
        type: 'telegram_config_response',
        success: true,
        hasBotToken: false,
        connected: false,
        hasWebhookSecret: false,
      });

      // Trigger reconcile to deregister webhook
      const effectiveUrl = process.env.INGRESS_PUBLIC_BASE_URL;
      if (effectiveUrl) {
        triggerGatewayReconcile(effectiveUrl);
      }
    } else if (msg.action === 'set_commands') {
      const storedToken = getSecureKey('credential:telegram:bot_token');
      if (!storedToken) {
        ctx.send(socket, {
          type: 'telegram_config_response',
          success: false,
          hasBotToken: false,
          connected: false,
          hasWebhookSecret: false,
          error: 'Bot token not configured. Run set action first.',
        });
        return;
      }

      const commands = msg.commands ?? [
        { command: 'new', description: 'Start a new conversation' },
        { command: 'help', description: 'Show available commands' },
        { command: 'guardian_verify', description: 'Verify your guardian identity' },
      ];

      try {
        const res = await fetch(`https://api.telegram.org/bot${storedToken}/setMyCommands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commands }),
        });
        if (!res.ok) {
          const body = await res.text();
          ctx.send(socket, {
            type: 'telegram_config_response',
            success: false,
            hasBotToken: true,
            connected: !!getSecureKey('credential:telegram:webhook_secret'),
            hasWebhookSecret: !!getSecureKey('credential:telegram:webhook_secret'),
            error: `Failed to set bot commands: ${body}`,
          });
          return;
        }
      } catch (err) {
        const message = summarizeTelegramError(err);
        ctx.send(socket, {
          type: 'telegram_config_response',
          success: false,
          hasBotToken: true,
          connected: !!getSecureKey('credential:telegram:webhook_secret'),
          hasWebhookSecret: !!getSecureKey('credential:telegram:webhook_secret'),
          error: `Failed to set bot commands: ${message}`,
        });
        return;
      }

      const hasBotToken = !!getSecureKey('credential:telegram:bot_token');
      const hasWebhookSecret = !!getSecureKey('credential:telegram:webhook_secret');
      ctx.send(socket, {
        type: 'telegram_config_response',
        success: true,
        hasBotToken,
        connected: hasBotToken && hasWebhookSecret,
        hasWebhookSecret,
      });
    } else {
      ctx.send(socket, {
        type: 'telegram_config_response',
        success: false,
        hasBotToken: false,
        connected: false,
        hasWebhookSecret: false,
        error: `Unknown action: ${String((msg as unknown as Record<string, unknown>).action)}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle Telegram config');
    ctx.send(socket, {
      type: 'telegram_config_response',
      success: false,
      hasBotToken: false,
      connected: false,
      hasWebhookSecret: false,
      error: message,
    });
  }
}

/** In-memory store for the last SMS send test result. Shared between sms_send_test and sms_doctor. */
let _lastTestResult: {
  messageSid: string;
  to: string;
  initialStatus: string;
  finalStatus: string;
  errorCode?: string;
  errorMessage?: string;
  timestamp: number;
} | undefined;

/** Map a Twilio error code to a human-readable remediation suggestion. */
function mapTwilioErrorRemediation(errorCode: string | undefined): string | undefined {
  if (!errorCode) return undefined;
  const map: Record<string, string> = {
    '30003': 'Unreachable destination. The handset may be off or out of service.',
    '30004': 'Message blocked by carrier or recipient.',
    '30005': 'Unknown destination phone number. Verify the number is valid.',
    '30006': 'Landline or unreachable carrier. SMS cannot be delivered to this number.',
    '30007': 'Message flagged as spam by carrier. Adjust content or register for A2P.',
    '30008': 'Unknown error from the carrier network.',
    '21610': 'Recipient has opted out (STOP). Cannot send until they opt back in.',
  };
  return map[errorCode];
}

const TWILIO_USE_CASE_ALIASES: Record<string, string> = {
  ACCOUNT_NOTIFICATION: 'ACCOUNT_NOTIFICATIONS',
  DELIVERY_NOTIFICATION: 'DELIVERY_NOTIFICATIONS',
  FRAUD_ALERT: 'FRAUD_ALERT_MESSAGING',
  POLLING_AND_VOTING: 'POLLING_AND_VOTING_NON_POLITICAL',
};

const TWILIO_VALID_USE_CASE_CATEGORIES = [
  'TWO_FACTOR_AUTHENTICATION',
  'ACCOUNT_NOTIFICATIONS',
  'CUSTOMER_CARE',
  'CHARITY_NONPROFIT',
  'DELIVERY_NOTIFICATIONS',
  'FRAUD_ALERT_MESSAGING',
  'EVENTS',
  'HIGHER_EDUCATION',
  'K12',
  'MARKETING',
  'POLLING_AND_VOTING_NON_POLITICAL',
  'POLITICAL_ELECTION_CAMPAIGNS',
  'PUBLIC_SERVICE_ANNOUNCEMENT',
  'SECURITY_ALERT',
] as const;

function normalizeUseCaseCategories(rawCategories: string[]): string[] {
  const normalized = rawCategories.map((value) => TWILIO_USE_CASE_ALIASES[value] ?? value);
  return Array.from(new Set(normalized));
}

export async function handleTwilioConfig(
  msg: TwilioConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    if (msg.action === 'get') {
      const hasCredentials = hasTwilioCredentials();
      const raw = loadRawConfig();
      const sms = (raw?.sms ?? {}) as Record<string, unknown>;
      // When assistantId is provided, look up in assistantPhoneNumbers first,
      // fall back to the legacy phoneNumber field
      let phoneNumber: string;
      if (msg.assistantId) {
        const mapping = (sms.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
        phoneNumber = mapping[msg.assistantId] ?? (sms.phoneNumber as string) ?? '';
      } else {
        phoneNumber = (sms.phoneNumber as string) ?? '';
      }
      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials,
        phoneNumber: phoneNumber || undefined,
      });
    } else if (msg.action === 'set_credentials') {
      if (!msg.accountSid || !msg.authToken) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: hasTwilioCredentials(),
          error: 'accountSid and authToken are required for set_credentials action',
        });
        return;
      }

      // Validate credentials by calling the Twilio API
      const authHeader = 'Basic ' + Buffer.from(`${msg.accountSid}:${msg.authToken}`).toString('base64');
      try {
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${msg.accountSid}.json`,
          {
            method: 'GET',
            headers: { Authorization: authHeader },
          },
        );
        if (!res.ok) {
          const body = await res.text();
          ctx.send(socket, {
            type: 'twilio_config_response',
            success: false,
            hasCredentials: hasTwilioCredentials(),
            error: `Twilio API validation failed (${res.status}): ${body}`,
          });
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: hasTwilioCredentials(),
          error: `Failed to validate Twilio credentials: ${message}`,
        });
        return;
      }

      // Store credentials securely
      const sidStored = setSecureKey('credential:twilio:account_sid', msg.accountSid);
      if (!sidStored) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Failed to store Account SID in secure storage',
        });
        return;
      }

      const tokenStored = setSecureKey('credential:twilio:auth_token', msg.authToken);
      if (!tokenStored) {
        // Roll back the Account SID
        deleteSecureKey('credential:twilio:account_sid');
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Failed to store Auth Token in secure storage',
        });
        return;
      }

      upsertCredentialMetadata('twilio', 'account_sid', {});
      upsertCredentialMetadata('twilio', 'auth_token', {});

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
      });
    } else if (msg.action === 'clear_credentials') {
      // Only clear authentication credentials (Account SID and Auth Token).
      // Preserve the phone number in both config (sms.phoneNumber) and secure
      // key (credential:twilio:phone_number) so that re-entering credentials
      // resumes working without needing to reassign the number.
      deleteSecureKey('credential:twilio:account_sid');
      deleteSecureKey('credential:twilio:auth_token');
      deleteCredentialMetadata('twilio', 'account_sid');
      deleteCredentialMetadata('twilio', 'auth_token');

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: false,
      });
    } else if (msg.action === 'provision_number') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;
      const country = msg.country ?? 'US';

      // Search for an available number
      const available = await searchAvailableNumbers(accountSid, authToken, country, msg.areaCode);
      if (available.length === 0) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `No available phone numbers found for country=${country}${msg.areaCode ? ` areaCode=${msg.areaCode}` : ''}`,
        });
        return;
      }

      // Purchase the first available number
      const purchased = await provisionPhoneNumber(accountSid, authToken, available[0].phoneNumber);

      // Auto-assign: persist the purchased number in secure storage and config
      // (same persistence as assign_number for consistency)
      const phoneStored = setSecureKey('credential:twilio:phone_number', purchased.phoneNumber);
      if (!phoneStored) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: hasTwilioCredentials(),
          phoneNumber: purchased.phoneNumber,
          error: `Phone number ${purchased.phoneNumber} was purchased but could not be saved. Use assign_number to assign it manually.`,
        });
        return;
      }

      const raw = loadRawConfig();
      const sms = (raw?.sms ?? {}) as Record<string, unknown>;
      // When assistantId is provided, only set the legacy global phoneNumber
      // if it's not already set — this prevents multi-assistant assignments
      // from clobbering each other's outbound SMS number.
      if (msg.assistantId) {
        if (!sms.phoneNumber) {
          sms.phoneNumber = purchased.phoneNumber;
        }
      } else {
        sms.phoneNumber = purchased.phoneNumber;
      }
      // When assistantId is provided, also persist into the per-assistant mapping
      if (msg.assistantId) {
        const mapping = (sms.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
        mapping[msg.assistantId] = purchased.phoneNumber;
        sms.assistantPhoneNumbers = mapping;
      }

      const wasSuppressed = ctx.suppressConfigReload;
      ctx.setSuppressConfigReload(true);
      try {
        saveRawConfig({ ...raw, sms });
      } catch (err) {
        ctx.setSuppressConfigReload(wasSuppressed);
        throw err;
      }
      ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

      // Best-effort webhook configuration — non-fatal so the number is
      // still usable even if ingress isn't configured yet.
      const webhookResult = await syncTwilioWebhooks(
        purchased.phoneNumber,
        accountSid,
        authToken,
        loadRawConfig() as IngressConfig,
      );

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        phoneNumber: purchased.phoneNumber,
        warning: webhookResult.warning,
      });
    } else if (msg.action === 'assign_number') {
      if (!msg.phoneNumber) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: hasTwilioCredentials(),
          error: 'phoneNumber is required for assign_number action',
        });
        return;
      }

      // Persist the phone number in the secure credential store so the
      // active Twilio runtime can read it via credential:twilio:phone_number
      const phoneStored = setSecureKey('credential:twilio:phone_number', msg.phoneNumber);
      if (!phoneStored) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: hasTwilioCredentials(),
          error: 'Failed to store phone number in secure storage',
        });
        return;
      }

      // Also persist in assistant config (non-secret) for the UI
      const raw = loadRawConfig();
      const sms = (raw?.sms ?? {}) as Record<string, unknown>;
      // When assistantId is provided, only set the legacy global phoneNumber
      // if it's not already set — this prevents multi-assistant assignments
      // from clobbering each other's outbound SMS number.
      if (msg.assistantId) {
        if (!sms.phoneNumber) {
          sms.phoneNumber = msg.phoneNumber;
        }
      } else {
        sms.phoneNumber = msg.phoneNumber;
      }
      // When assistantId is provided, also persist into the per-assistant mapping
      if (msg.assistantId) {
        const mapping = (sms.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
        mapping[msg.assistantId] = msg.phoneNumber;
        sms.assistantPhoneNumbers = mapping;
      }

      const wasSuppressed = ctx.suppressConfigReload;
      ctx.setSuppressConfigReload(true);
      try {
        saveRawConfig({ ...raw, sms });
      } catch (err) {
        ctx.setSuppressConfigReload(wasSuppressed);
        throw err;
      }
      ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

      // Best-effort webhook configuration when credentials are available
      let webhookWarning: string | undefined;
      if (hasTwilioCredentials()) {
        const acctSid = getSecureKey('credential:twilio:account_sid')!;
        const acctToken = getSecureKey('credential:twilio:auth_token')!;
        const webhookResult = await syncTwilioWebhooks(
          msg.phoneNumber,
          acctSid,
          acctToken,
          loadRawConfig() as IngressConfig,
        );
        webhookWarning = webhookResult.warning;
      }

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: hasTwilioCredentials(),
        phoneNumber: msg.phoneNumber,
        warning: webhookWarning,
      });
    } else if (msg.action === 'list_numbers') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;
      const numbers = await listIncomingPhoneNumbers(accountSid, authToken);

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        numbers,
      });
    } else if (msg.action === 'sms_compliance_status') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      const raw = loadRawConfig();
      const sms = (raw?.sms ?? {}) as Record<string, unknown>;
      let phoneNumber: string;
      if (msg.assistantId) {
        const mapping = (sms.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
        phoneNumber = mapping[msg.assistantId] ?? (sms.phoneNumber as string) ?? '';
      } else {
        phoneNumber = (sms.phoneNumber as string) ?? '';
      }

      if (!phoneNumber) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'No phone number assigned. Assign a number first.',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;

      // Determine number type from prefix
      const tollFreePrefixes = ['+1800', '+1833', '+1844', '+1855', '+1866', '+1877', '+1888'];
      const isTollFree = tollFreePrefixes.some((prefix) => phoneNumber.startsWith(prefix));
      const numberType = isTollFree ? 'toll_free' : 'local_10dlc';

      if (!isTollFree) {
        // Non-toll-free numbers don't need toll-free verification
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: true,
          hasCredentials: true,
          phoneNumber,
          compliance: { numberType },
        });
        return;
      }

      // Look up the phone number SID and check verification status
      const phoneSid = await getPhoneNumberSid(accountSid, authToken, phoneNumber);
      if (!phoneSid) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          phoneNumber,
          error: `Phone number ${phoneNumber} not found on Twilio account`,
        });
        return;
      }

      const verification = await getTollFreeVerificationStatus(accountSid, authToken, phoneSid);

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        phoneNumber,
        compliance: {
          numberType,
          verificationSid: verification?.sid,
          verificationStatus: verification?.status,
          rejectionReason: verification?.rejectionReason,
          rejectionReasons: verification?.rejectionReasons,
          errorCode: verification?.errorCode,
          editAllowed: verification?.editAllowed,
          editExpiration: verification?.editExpiration,
        },
      });
    } else if (msg.action === 'sms_submit_tollfree_verification') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      const vp = msg.verificationParams;
      if (!vp) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'verificationParams is required for sms_submit_tollfree_verification action',
        });
        return;
      }

      // Validate required fields
      const requiredFields: Array<[string, unknown]> = [
        ['tollfreePhoneNumberSid', vp.tollfreePhoneNumberSid],
        ['businessName', vp.businessName],
        ['businessWebsite', vp.businessWebsite],
        ['notificationEmail', vp.notificationEmail],
        ['useCaseCategories', vp.useCaseCategories],
        ['useCaseSummary', vp.useCaseSummary],
        ['productionMessageSample', vp.productionMessageSample],
        ['optInImageUrls', vp.optInImageUrls],
        ['optInType', vp.optInType],
        ['messageVolume', vp.messageVolume],
      ];

      const missing = requiredFields
        .filter(([, v]) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))
        .map(([name]) => name);

      if (missing.length > 0) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `Missing required verification fields: ${missing.join(', ')}`,
        });
        return;
      }

      // Validate enum values
      const normalizedUseCaseCategories = normalizeUseCaseCategories(vp.useCaseCategories ?? []);
      const invalidCategories = normalizedUseCaseCategories.filter(
        (c) => !TWILIO_VALID_USE_CASE_CATEGORIES.includes(c as (typeof TWILIO_VALID_USE_CASE_CATEGORIES)[number]),
      );
      if (invalidCategories.length > 0) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `Invalid useCaseCategories: ${invalidCategories.join(', ')}. Valid values: ${TWILIO_VALID_USE_CASE_CATEGORIES.join(', ')}`,
        });
        return;
      }

      const validOptInTypes = ['VERBAL', 'WEB_FORM', 'PAPER_FORM', 'VIA_TEXT', 'MOBILE_QR_CODE'];
      if (!validOptInTypes.includes(vp.optInType!)) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `Invalid optInType: ${vp.optInType}. Valid values: ${validOptInTypes.join(', ')}`,
        });
        return;
      }

      const validMessageVolumes = [
        '10', '100', '1,000', '10,000', '100,000', '250,000',
        '500,000', '750,000', '1,000,000', '5,000,000', '10,000,000+',
      ];
      if (!validMessageVolumes.includes(vp.messageVolume!)) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `Invalid messageVolume: ${vp.messageVolume}. Valid values: ${validMessageVolumes.join(', ')}`,
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;

      const submitParams: TollFreeVerificationSubmitParams = {
        tollfreePhoneNumberSid: vp.tollfreePhoneNumberSid!,
        businessName: vp.businessName!,
        businessWebsite: vp.businessWebsite!,
        notificationEmail: vp.notificationEmail!,
        useCaseCategories: normalizedUseCaseCategories,
        useCaseSummary: vp.useCaseSummary!,
        productionMessageSample: vp.productionMessageSample!,
        optInImageUrls: vp.optInImageUrls!,
        optInType: vp.optInType!,
        messageVolume: vp.messageVolume!,
        businessType: vp.businessType ?? 'SOLE_PROPRIETOR',
        customerProfileSid: vp.customerProfileSid,
      };

      const verification = await submitTollFreeVerification(accountSid, authToken, submitParams);

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        compliance: {
          numberType: 'toll_free',
          verificationSid: verification.sid,
          verificationStatus: verification.status,
        },
      });
    } else if (msg.action === 'sms_update_tollfree_verification') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      if (!msg.verificationSid) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'verificationSid is required for sms_update_tollfree_verification action',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;

      const currentVerification = await getTollFreeVerificationBySid(accountSid, authToken, msg.verificationSid);
      if (!currentVerification) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `Verification ${msg.verificationSid} was not found on this Twilio account.`,
        });
        return;
      }

      if (currentVerification.status === 'TWILIO_REJECTED') {
        const expirationMillis = currentVerification.editExpiration
          ? Date.parse(currentVerification.editExpiration)
          : Number.NaN;
        const editExpired = Number.isFinite(expirationMillis) && Date.now() > expirationMillis;
        if (currentVerification.editAllowed === false || editExpired) {
          const detail = editExpired
            ? `edit_expiration=${currentVerification.editExpiration}`
            : 'edit_allowed=false';
          ctx.send(socket, {
            type: 'twilio_config_response',
            success: false,
            hasCredentials: true,
            error: `Verification ${msg.verificationSid} cannot be updated (${detail}). Delete and resubmit instead.`,
            compliance: {
              numberType: 'toll_free',
              verificationSid: currentVerification.sid,
              verificationStatus: currentVerification.status,
              editAllowed: currentVerification.editAllowed,
              editExpiration: currentVerification.editExpiration,
            },
          });
          return;
        }
      }

      const updateParams = { ...(msg.verificationParams ?? {}) };
      if (updateParams.useCaseCategories) {
        updateParams.useCaseCategories = normalizeUseCaseCategories(updateParams.useCaseCategories);
      }

      const verification = await updateTollFreeVerification(
        accountSid,
        authToken,
        msg.verificationSid,
        updateParams,
      );

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        compliance: {
          numberType: 'toll_free',
          verificationSid: verification.sid,
          verificationStatus: verification.status,
          editAllowed: verification.editAllowed,
          editExpiration: verification.editExpiration,
        },
      });
    } else if (msg.action === 'sms_delete_tollfree_verification') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      if (!msg.verificationSid) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'verificationSid is required for sms_delete_tollfree_verification action',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;

      await deleteTollFreeVerification(accountSid, authToken, msg.verificationSid);

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        warning: 'Toll-free verification deleted. Re-submitting may reset your position in the review queue.',
      });
    } else if (msg.action === 'release_number') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      const raw = loadRawConfig();
      const sms = (raw?.sms ?? {}) as Record<string, unknown>;
      let phoneNumber: string;
      if (msg.phoneNumber) {
        phoneNumber = msg.phoneNumber;
      } else if (msg.assistantId) {
        const mapping = (sms.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
        phoneNumber = mapping[msg.assistantId] ?? (sms.phoneNumber as string) ?? '';
      } else {
        phoneNumber = (sms.phoneNumber as string) ?? '';
      }

      if (!phoneNumber) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'No phone number to release. Specify phoneNumber or ensure one is assigned.',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;

      await releasePhoneNumber(accountSid, authToken, phoneNumber);

      // Clear the number from config and secure key store
      if (sms.phoneNumber === phoneNumber) {
        delete sms.phoneNumber;
      }
      const assistantPhoneNumbers = sms.assistantPhoneNumbers as Record<string, string> | undefined;
      if (assistantPhoneNumbers) {
        for (const [id, num] of Object.entries(assistantPhoneNumbers)) {
          if (num === phoneNumber) {
            delete assistantPhoneNumbers[id];
          }
        }
        if (Object.keys(assistantPhoneNumbers).length === 0) {
          delete sms.assistantPhoneNumbers;
        }
      }

      const wasSuppressed = ctx.suppressConfigReload;
      ctx.setSuppressConfigReload(true);
      try {
        saveRawConfig({ ...raw, sms });
      } catch (err) {
        ctx.setSuppressConfigReload(wasSuppressed);
        throw err;
      }
      ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

      // Clear the phone number from secure key store if it matches
      const storedPhone = getSecureKey('credential:twilio:phone_number');
      if (storedPhone === phoneNumber) {
        deleteSecureKey('credential:twilio:phone_number');
      }

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        warning: 'Phone number released from Twilio. Any associated toll-free verification context is lost.',
      });
    } else if (msg.action === 'sms_send_test') {
      // ── SMS send test ────────────────────────────────────────────────
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      const to = msg.phoneNumber;
      if (!to) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'phoneNumber is required for sms_send_test action.',
        });
        return;
      }

      const raw = loadRawConfig();
      const smsSection = (raw?.sms ?? {}) as Record<string, unknown>;
      let from = '';
      // When assistantId is provided, check assistant-scoped phone mapping first
      if (msg.assistantId) {
        const mapping = (smsSection.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
        from = mapping[msg.assistantId] ?? '';
      }
      // Fall back to global phone number
      if (!from) {
        from = (smsSection.phoneNumber as string | undefined)
          || getSecureKey('credential:twilio:phone_number')
          || '';
      }
      if (!from) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'No phone number assigned. Run the twilio-setup skill to assign a number.',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;
      const text = msg.text || 'Test SMS from your Vellum assistant';

      // Send via gateway's /deliver/sms endpoint
      const bearerToken = readHttpToken();
      const gatewayPort = Number(process.env.GATEWAY_PORT) || 7830;
      const gatewayUrl = process.env.GATEWAY_INTERNAL_BASE_URL?.replace(/\/+$/, '') || `http://127.0.0.1:${gatewayPort}`;

      const sendResp = await fetch(`${gatewayUrl}/deliver/sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        },
        body: JSON.stringify({ to, text, ...(msg.assistantId ? { assistantId: msg.assistantId } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!sendResp.ok) {
        const errBody = await sendResp.text().catch(() => '<unreadable>');
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `SMS send failed (${sendResp.status}): ${errBody}`,
        });
        return;
      }

      const sendData = await sendResp.json().catch(() => ({})) as {
        messageSid?: string;
        status?: string;
      };
      const messageSid = sendData.messageSid || '';
      const initialStatus = sendData.status || 'unknown';

      // Poll Twilio for final status (up to 3 times, 2s apart)
      let finalStatus = initialStatus;
      let errorCode: string | undefined;
      let errorMessage: string | undefined;

      if (messageSid) {
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const pollResult = await fetchMessageStatus(accountSid, authToken, messageSid);
            finalStatus = pollResult.status;
            errorCode = pollResult.errorCode;
            errorMessage = pollResult.errorMessage;
            // Stop polling if we've reached a terminal status
            if (['delivered', 'undelivered', 'failed'].includes(finalStatus)) break;
          } catch {
            // Polling failure is non-fatal; we'll use the last known status
            break;
          }
        }
      }

      const testResult = {
        messageSid,
        to,
        initialStatus,
        finalStatus,
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      };

      // Store for sms_doctor
      _lastTestResult = { ...testResult, timestamp: Date.now() };

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        testResult,
      });

    } else if (msg.action === 'sms_doctor') {
      // ── SMS doctor diagnostic ────────────────────────────────────────
      const hasCredentials = hasTwilioCredentials();

      // 1. Channel readiness check
      let readinessReady = false;
      const readinessIssues: string[] = [];
      try {
        const readinessService = getReadinessService();
        const snapshots = await readinessService.getReadiness('sms', false, msg.assistantId);
        const snapshot = snapshots[0];
        if (snapshot) {
          readinessReady = snapshot.ready;
          for (const r of snapshot.reasons) {
            readinessIssues.push(r.text);
          }
        } else {
          readinessIssues.push('No readiness snapshot returned for SMS channel');
        }
      } catch (err) {
        readinessIssues.push(`Readiness check failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 2. Compliance status
      let complianceStatus = 'unknown';
      let complianceDetail: string | undefined;
      let complianceRemediation: string | undefined;
      if (hasCredentials) {
        try {
          const raw = loadRawConfig();
          const smsSection = (raw?.sms ?? {}) as Record<string, unknown>;
          let phoneNumber = '';
          if (msg.assistantId) {
            const mapping = (smsSection.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
            phoneNumber = mapping[msg.assistantId] ?? '';
          }
          if (!phoneNumber) {
            phoneNumber = (smsSection.phoneNumber as string | undefined) || getSecureKey('credential:twilio:phone_number') || '';
          }
          if (phoneNumber) {
            const accountSid = getSecureKey('credential:twilio:account_sid')!;
            const authToken = getSecureKey('credential:twilio:auth_token')!;
            // Determine number type and verification status
            const isTollFree = phoneNumber.startsWith('+1') && ['800','888','877','866','855','844','833'].some(
              (p) => phoneNumber.startsWith(`+1${p}`),
            );
            if (isTollFree) {
              try {
                const phoneSid = await getPhoneNumberSid(accountSid, authToken, phoneNumber);
                if (!phoneSid) {
                  complianceStatus = 'check_failed';
                  complianceDetail = `Assigned number ${phoneNumber} was not found on the Twilio account`;
                  complianceRemediation = 'Reassign the number in twilio-setup or update credentials to the matching account.';
                } else {
                  const verification = await getTollFreeVerificationStatus(accountSid, authToken, phoneSid);
                  if (verification) {
                    const status = verification.status;
                    complianceStatus = status;
                    complianceDetail = `Toll-free verification: ${status}`;
                    if (status === 'TWILIO_APPROVED') {
                      complianceRemediation = undefined;
                    } else if (status === 'PENDING_REVIEW' || status === 'IN_REVIEW') {
                      complianceRemediation = 'Toll-free verification is pending. Messaging may have limited throughput until approved.';
                    } else if (status === 'TWILIO_REJECTED') {
                      if (verification.editAllowed) {
                        complianceRemediation = verification.editExpiration
                          ? `Toll-free verification was rejected but can still be edited until ${verification.editExpiration}. Update and resubmit it.`
                          : 'Toll-free verification was rejected but can still be edited. Update and resubmit it.';
                      } else {
                        complianceRemediation = 'Toll-free verification was rejected and is no longer editable. Delete and resubmit it.';
                      }
                    } else {
                      complianceRemediation = 'Submit a toll-free verification to enable full messaging throughput.';
                    }
                  } else {
                    complianceStatus = 'unverified';
                    complianceDetail = 'Toll-free number without verification';
                    complianceRemediation = 'Submit a toll-free verification request to avoid filtering.';
                  }
                }
              } catch {
                complianceStatus = 'check_failed';
                complianceDetail = 'Could not retrieve toll-free verification status';
              }
            } else {
              complianceStatus = 'local_10dlc';
              complianceDetail = 'Local/10DLC number — carrier registration handled externally';
            }
          } else {
            complianceStatus = 'no_number';
            complianceDetail = 'No phone number assigned';
            complianceRemediation = 'Assign a phone number via the twilio-setup skill.';
          }
        } catch {
          complianceStatus = 'check_failed';
          complianceDetail = 'Could not determine compliance status';
        }
      } else {
        complianceStatus = 'no_credentials';
        complianceDetail = 'Twilio credentials are not configured';
        complianceRemediation = 'Set Twilio credentials via the twilio-setup skill.';
      }

      // 3. Last send test result
      let lastSend: { status: string; errorCode?: string; remediation?: string } | undefined;
      if (_lastTestResult) {
        lastSend = {
          status: _lastTestResult.finalStatus,
          ...((_lastTestResult.errorCode) ? { errorCode: _lastTestResult.errorCode } : {}),
          ...((_lastTestResult.errorCode) ? { remediation: mapTwilioErrorRemediation(_lastTestResult.errorCode) } : {}),
        };
      }

      // 4. Determine overall status
      const actionItems: string[] = [];
      let overallStatus: 'healthy' | 'degraded' | 'broken' = 'healthy';

      if (!hasCredentials) {
        overallStatus = 'broken';
        actionItems.push('Configure Twilio credentials.');
      }
      if (!readinessReady) {
        overallStatus = 'broken';
        for (const issue of readinessIssues) actionItems.push(issue);
      }
      if (complianceStatus === 'unverified' || complianceStatus === 'PENDING_REVIEW' || complianceStatus === 'IN_REVIEW') {
        if (overallStatus === 'healthy') overallStatus = 'degraded';
        if (complianceRemediation) actionItems.push(complianceRemediation);
      }
      if (complianceStatus === 'TWILIO_REJECTED' || complianceStatus === 'no_number') {
        overallStatus = 'broken';
        if (complianceRemediation) actionItems.push(complianceRemediation);
      }
      if (_lastTestResult && ['failed', 'undelivered'].includes(_lastTestResult.finalStatus)) {
        if (overallStatus === 'healthy') overallStatus = 'degraded';
        const remediation = mapTwilioErrorRemediation(_lastTestResult.errorCode);
        actionItems.push(remediation || `Last test SMS ${_lastTestResult.finalStatus}. Check Twilio logs for details.`);
      }

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials,
        diagnostics: {
          readiness: { ready: readinessReady, issues: readinessIssues },
          compliance: {
            status: complianceStatus,
            ...(complianceDetail ? { detail: complianceDetail } : {}),
            ...(complianceRemediation ? { remediation: complianceRemediation } : {}),
          },
          ...(lastSend ? { lastSend } : {}),
          overallStatus,
          actionItems,
        },
      });

    } else {
      ctx.send(socket, {
        type: 'twilio_config_response',
        success: false,
        hasCredentials: hasTwilioCredentials(),
        error: `Unknown action: ${String((msg as unknown as Record<string, unknown>).action)}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle Twilio config');
    ctx.send(socket, {
      type: 'twilio_config_response',
      success: false,
      hasCredentials: hasTwilioCredentials(),
      error: message,
    });
  }
}

export function handleGuardianVerification(
  msg: GuardianVerificationRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Use the assistant ID from the request when available; fall back to
  // 'self' for backward compatibility with single-assistant mode.
  const assistantId = msg.assistantId ?? 'self';
  const channel = msg.channel ?? 'telegram';

  try {
    if (msg.action === 'create_challenge') {
      const result = createVerificationChallenge(assistantId, channel, msg.sessionId);

      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: true,
        secret: result.secret,
        instruction: result.instruction,
        channel,
      });
    } else if (msg.action === 'status') {
      const binding = getGuardianBinding(assistantId, channel);
      let guardianUsername: string | undefined;
      let guardianDisplayName: string | undefined;
      if (binding?.metadataJson) {
        try {
          const parsed = JSON.parse(binding.metadataJson) as Record<string, unknown>;
          if (typeof parsed.username === 'string' && parsed.username.trim().length > 0) {
            guardianUsername = parsed.username.trim();
          }
          if (typeof parsed.displayName === 'string' && parsed.displayName.trim().length > 0) {
            guardianDisplayName = parsed.displayName.trim();
          }
        } catch {
          // ignore malformed metadata
        }
      }
      if (binding?.guardianDeliveryChatId && (!guardianUsername || !guardianDisplayName)) {
        const ext = externalConversationStore.getBindingByChannelChat(
          channel,
          binding.guardianDeliveryChatId,
        );
        if (!guardianUsername && ext?.username) {
          guardianUsername = ext.username;
        }
        if (!guardianDisplayName && ext?.displayName) {
          guardianDisplayName = ext.displayName;
        }
      }
      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: true,
        bound: binding !== null,
        guardianExternalUserId: binding?.guardianExternalUserId,
        guardianUsername,
        guardianDisplayName,
        channel,
        assistantId,
        guardianDeliveryChatId: binding?.guardianDeliveryChatId,
      });
    } else if (msg.action === 'revoke') {
      revokeGuardianBinding(assistantId, channel);
      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: true,
        bound: false,
        channel,
      });
    } else {
      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: false,
        error: `Unknown action: ${String(msg.action)}`,
        channel,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle guardian verification');
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: message,
      channel,
    });
  }
}

// Lazy singleton — created on first use so module-load stays lightweight.
let _readinessService: ChannelReadinessService | undefined;
function getReadinessService(): ChannelReadinessService {
  if (!_readinessService) {
    _readinessService = createReadinessService();
  }
  return _readinessService;
}

export async function handleChannelReadiness(
  msg: ChannelReadinessRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const service = getReadinessService();

    if (msg.action === 'refresh') {
      if (msg.channel) {
        service.invalidateChannel(msg.channel, msg.assistantId);
      } else {
        service.invalidateAll();
      }
    }

    const snapshots = await service.getReadiness(msg.channel, msg.includeRemote, msg.assistantId);

    ctx.send(socket, {
      type: 'channel_readiness_response',
      success: true,
      snapshots: snapshots.map((s) => ({
        channel: s.channel,
        ready: s.ready,
        checkedAt: s.checkedAt,
        stale: s.stale,
        reasons: s.reasons,
        localChecks: s.localChecks,
        remoteChecks: s.remoteChecks,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle channel readiness');
    ctx.send(socket, {
      type: 'channel_readiness_response',
      success: false,
      error: message,
    });
  }
}

export function handleEnvVarsRequest(socket: net.Socket, ctx: HandlerContext): void {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) vars[key] = value;
  }
  ctx.send(socket, { type: 'env_vars_response', vars });
}

/**
 * Look up manifest metadata for a tool that isn't in the live registry.
 * Searches all installed skills' TOOLS.json manifests for a matching tool name.
 */
function resolveManifestOverride(toolName: string): ManifestOverride | undefined {
  if (getTool(toolName)) return undefined;
  try {
    const catalog = loadSkillCatalog();
    for (const skill of catalog) {
      if (!skill.toolManifest?.present || !skill.toolManifest.valid) continue;
      try {
        const manifest = parseToolManifestFile(join(skill.directoryPath, 'TOOLS.json'));
        const entry = manifest.tools.find((t) => t.name === toolName);
        if (entry) {
          return { risk: entry.risk, execution_target: entry.execution_target };
        }
      } catch {
        // Skip unparseable manifests
      }
    }
  } catch {
    // Non-fatal
  }
  return undefined;
}

export async function handleToolPermissionSimulate(
  msg: ToolPermissionSimulateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    if (!msg.toolName || typeof msg.toolName !== 'string') {
      ctx.send(socket, {
        type: 'tool_permission_simulate_response',
        success: false,
        error: 'toolName is required',
      });
      return;
    }
    if (!msg.input || typeof msg.input !== 'object') {
      ctx.send(socket, {
        type: 'tool_permission_simulate_response',
        success: false,
        error: 'input is required and must be an object',
      });
      return;
    }

    const workingDir = msg.workingDir ?? process.cwd();

    // For unregistered skill tools, resolve manifest metadata so the simulation
    // uses accurate risk/execution_target values instead of falling back to defaults.
    const manifestOverride = resolveManifestOverride(msg.toolName);

    const executionTarget = resolveExecutionTarget(msg.toolName, manifestOverride);
    const policyContext = { executionTarget };

    const riskLevel = await classifyRisk(msg.toolName, msg.input, workingDir, undefined, manifestOverride);
    const result = await check(msg.toolName, msg.input, workingDir, policyContext, manifestOverride);

    // Private-thread override: promote allow → prompt for side-effect tools
    if (
      msg.forcePromptSideEffects
      && result.decision === 'allow'
      && isSideEffectTool(msg.toolName, msg.input)
    ) {
      result.decision = 'prompt';
      result.reason = 'Private thread: side-effect tools require explicit approval';
    }

    // Non-interactive override: convert prompt → deny
    if (msg.isInteractive === false && result.decision === 'prompt') {
      result.decision = 'deny';
      result.reason = 'Non-interactive session: no client to approve prompt';
    }

    // When decision is prompt, generate the full payload the UI needs
    let promptPayload: {
      allowlistOptions: Array<{ label: string; description: string; pattern: string }>;
      scopeOptions: Array<{ label: string; scope: string }>;
      persistentDecisionsAllowed: boolean;
    } | undefined;

    if (result.decision === 'prompt') {
      const allowlistOptions = await generateAllowlistOptions(msg.toolName, msg.input);
      const scopeOptions = generateScopeOptions(workingDir, msg.toolName);
      const persistentDecisionsAllowed = !(
        msg.toolName === 'bash'
        && msg.input.network_mode === 'proxied'
      );
      promptPayload = { allowlistOptions, scopeOptions, persistentDecisionsAllowed };
    }

    ctx.send(socket, {
      type: 'tool_permission_simulate_response',
      success: true,
      decision: result.decision,
      riskLevel,
      reason: result.reason,
      executionTarget,
      matchedRuleId: result.matchedRule?.id,
      promptPayload,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to simulate tool permission');
    ctx.send(socket, {
      type: 'tool_permission_simulate_response',
      success: false,
      error: message,
    });
  }
}

export function handleToolNamesList(socket: net.Socket, ctx: HandlerContext): void {
  const tools = getAllTools();
  const nameSet = new Set(tools.map((t) => t.name));
  const schemas: Record<string, import('../ipc-contract.js').ToolInputSchema> = {};
  for (const tool of tools) {
    try {
      const def = tool.getDefinition();
      schemas[tool.name] = def.input_schema as import('../ipc-contract.js').ToolInputSchema;
    } catch {
      // Skip tools whose definitions can't be resolved
    }
  }

  // Include tools from all installed skills, even those not currently
  // activated in any session.
  try {
    const catalog = loadSkillCatalog();
    for (const skill of catalog) {
      if (!skill.toolManifest?.present || !skill.toolManifest.valid) continue;
      try {
        const manifest = parseToolManifestFile(join(skill.directoryPath, 'TOOLS.json'));
        for (const entry of manifest.tools) {
          if (nameSet.has(entry.name)) continue;
          nameSet.add(entry.name);
          schemas[entry.name] = entry.input_schema as unknown as import('../ipc-contract.js').ToolInputSchema;
        }
      } catch {
        // Skip skills whose manifests can't be parsed
      }
    }
  } catch {
    // Non-fatal — fall back to registered tools only
  }

  const names = Array.from(nameSet).sort((a, b) => a.localeCompare(b));
  ctx.send(socket, { type: 'tool_names_list_response', names, schemas });
}

export const configHandlers = defineHandlers({
  model_get: (_msg, socket, ctx) => handleModelGet(socket, ctx),
  model_set: handleModelSet,
  image_gen_model_set: handleImageGenModelSet,
  add_trust_rule: handleAddTrustRule,
  trust_rules_list: (_msg, socket, ctx) => handleTrustRulesList(socket, ctx),
  remove_trust_rule: handleRemoveTrustRule,
  update_trust_rule: handleUpdateTrustRule,
  accept_starter_bundle: (_msg, socket, ctx) => handleAcceptStarterBundle(socket, ctx),
  schedules_list: (_msg, socket, ctx) => handleSchedulesList(socket, ctx),
  schedule_toggle: handleScheduleToggle,
  schedule_remove: handleScheduleRemove,
  schedule_run_now: handleScheduleRunNow,
  reminders_list: (_msg, socket, ctx) => handleRemindersList(socket, ctx),
  reminder_cancel: handleReminderCancel,
  share_to_slack: handleShareToSlack,
  slack_webhook_config: handleSlackWebhookConfig,
  ingress_config: handleIngressConfig,
  vercel_api_config: handleVercelApiConfig,
  twitter_integration_config: handleTwitterIntegrationConfig,
  telegram_config: handleTelegramConfig,
  twilio_config: handleTwilioConfig,
  channel_readiness: handleChannelReadiness,
  guardian_verification: handleGuardianVerification,
  env_vars_request: (_msg, socket, ctx) => handleEnvVarsRequest(socket, ctx),
  tool_permission_simulate: handleToolPermissionSimulate,
  tool_names_list: (_msg, socket, ctx) => handleToolNamesList(socket, ctx),
});
