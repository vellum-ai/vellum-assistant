import * as net from 'node:net';
import { getConfig, loadRawConfig, saveRawConfig } from '../../config/loader.js';
import { initializeProviders } from '../../providers/registry.js';
import { addRule, removeRule, updateRule, getAllRules, acceptStarterBundle } from '../../permissions/trust-store.js';
import { classifyRisk, check, generateAllowlistOptions, generateScopeOptions } from '../../permissions/checker.js';
import { isSideEffectTool } from '../../tools/executor.js';
import { resolveExecutionTarget } from '../../tools/execution-target.js';
import { getAllTools } from '../../tools/registry.js';
import { listSchedules, updateSchedule, deleteSchedule, describeCronExpression } from '../../schedule/schedule-store.js';
import { listReminders, cancelReminder } from '../../tools/reminder/reminder-store.js';
import { getSecureKey, setSecureKey, deleteSecureKey } from '../../security/secure-keys.js';
import { upsertCredentialMetadata, deleteCredentialMetadata, getCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import { postToSlackWebhook } from '../../slack/slack-webhook.js';
import { getApp } from '../../memory/app-store.js';
import { readHttpToken } from '../../util/platform.js';
import type {
  ModelSetRequest,
  ImageGenModelSetRequest,
  AddTrustRule,
  RemoveTrustRule,
  UpdateTrustRule,
  ScheduleToggle,
  ScheduleRemove,
  ReminderCancel,
  ShareToSlackRequest,
  SlackWebhookConfigRequest,
  IngressConfigRequest,
  VercelApiConfigRequest,
  TwitterIntegrationConfigRequest,
  TelegramConfigRequest,
  TwilioConfigRequest,
  GuardianVerificationRequest,
  ToolPermissionSimulateRequest,
} from '../ipc-protocol.js';
import {
  hasTwilioCredentials,
  listIncomingPhoneNumbers,
  searchAvailableNumbers,
  provisionPhoneNumber,
  updatePhoneNumberWebhooks,
} from '../../calls/twilio-rest.js';
import {
  getTwilioVoiceWebhookUrl,
  getTwilioStatusCallbackUrl,
  getTwilioSmsWebhookUrl,
  type IngressConfig,
} from '../../inbound/public-ingress-urls.js';
import { createVerificationChallenge, getGuardianBinding, revokeBinding as revokeGuardianBinding } from '../../runtime/channel-guardian-service.js';
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
        error: 'No Slack webhook URL configured. Set one in Settings.',
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
  try {
    // Use the assistant ID from the request when available; fall back to
    // 'self' for backward compatibility with single-assistant mode.
    const assistantId = msg.assistantId ?? 'self';
    const channel = msg.channel ?? 'telegram';

    if (msg.action === 'create_challenge') {
      const result = createVerificationChallenge(assistantId, channel, msg.sessionId);

      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: true,
        secret: result.secret,
        instruction: result.instruction,
      });
    } else if (msg.action === 'status') {
      const binding = getGuardianBinding(assistantId, channel);
      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: true,
        bound: binding !== null,
        guardianExternalUserId: binding?.guardianExternalUserId,
      });
    } else if (msg.action === 'revoke') {
      revokeGuardianBinding(assistantId, channel);
      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: true,
        bound: false,
      });
    } else {
      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: false,
        error: `Unknown action: ${String(msg.action)}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle guardian verification');
    ctx.send(socket, {
      type: 'guardian_verification_response',
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

    // Resolve execution target using manifest metadata or prefix heuristics.
    // resolveExecutionTarget handles unregistered tools via prefix fallback.
    const executionTarget = resolveExecutionTarget(msg.toolName);
    const policyContext = { executionTarget };

    const riskLevel = await classifyRisk(msg.toolName, msg.input, workingDir);
    const result = await check(msg.toolName, msg.input, workingDir, policyContext);

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
  const names = tools.map((t) => t.name).sort((a, b) => a.localeCompare(b));
  const schemas: Record<string, import('../ipc-contract.js').ToolInputSchema> = {};
  for (const tool of tools) {
    try {
      const def = tool.getDefinition();
      schemas[tool.name] = def.input_schema as import('../ipc-contract.js').ToolInputSchema;
    } catch {
      // Skip tools whose definitions can't be resolved
    }
  }
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
  reminders_list: (_msg, socket, ctx) => handleRemindersList(socket, ctx),
  reminder_cancel: handleReminderCancel,
  share_to_slack: handleShareToSlack,
  slack_webhook_config: handleSlackWebhookConfig,
  ingress_config: handleIngressConfig,
  vercel_api_config: handleVercelApiConfig,
  twitter_integration_config: handleTwitterIntegrationConfig,
  telegram_config: handleTelegramConfig,
  twilio_config: handleTwilioConfig,
  guardian_verification: handleGuardianVerification,
  env_vars_request: (_msg, socket, ctx) => handleEnvVarsRequest(socket, ctx),
  tool_permission_simulate: handleToolPermissionSimulate,
  tool_names_list: (_msg, socket, ctx) => handleToolNamesList(socket, ctx),
});
