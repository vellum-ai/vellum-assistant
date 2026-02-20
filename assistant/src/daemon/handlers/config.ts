import * as net from 'node:net';
import { getConfig, loadRawConfig, saveRawConfig } from '../../config/loader.js';
import { initializeProviders } from '../../providers/registry.js';
import { addRule, removeRule, updateRule, getAllRules, acceptStarterBundle } from '../../permissions/trust-store.js';
import { listSchedules, updateSchedule, deleteSchedule, describeCronExpression } from '../../schedule/schedule-store.js';
import { listReminders, cancelReminder } from '../../tools/reminder/reminder-store.js';
import { getSecureKey, setSecureKey, deleteSecureKey } from '../../security/secure-keys.js';
import { upsertCredentialMetadata, deleteCredentialMetadata, getCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import { postToSlackWebhook } from '../../slack/slack-webhook.js';
import { getApp } from '../../memory/app-store.js';
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
} from '../ipc-protocol.js';
import { log, CONFIG_RELOAD_DEBOUNCE_MS, defineHandlers, type HandlerContext } from './shared.js';
import { MODEL_TO_PROVIDER } from '../session-slash.js';

// Snapshot the env-provided value at module load time so we can restore it
// when the user clears a Settings-set override.
const ORIGINAL_INGRESS_ENV = process.env.INGRESS_PUBLIC_BASE_URL;

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
    const existingSuppressTimer = ctx.debounceTimers.get('__suppress_reset__');
    if (existingSuppressTimer) clearTimeout(existingSuppressTimer);
    const resetTimer = setTimeout(() => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);
    ctx.debounceTimers.set('__suppress_reset__', resetTimer);

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
    const existingSuppressTimer = ctx.debounceTimers.get('__suppress_reset__');
    if (existingSuppressTimer) clearTimeout(existingSuppressTimer);
    const resetTimer = setTimeout(() => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);
    ctx.debounceTimers.set('__suppress_reset__', resetTimer);

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
    addRule(msg.toolName, msg.pattern, msg.scope, msg.decision);
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

function computeLocalGatewayTarget(): string {
  const portRaw = process.env.GATEWAY_PORT || '7830';
  const port = Number(portRaw) || 7830;
  return `http://127.0.0.1:${port}`;
}

export function handleIngressConfig(
  msg: IngressConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const localGatewayTarget = computeLocalGatewayTarget();
  try {
    if (msg.action === 'get') {
      const raw = loadRawConfig();
      const ingress = (raw?.ingress ?? {}) as Record<string, unknown>;
      const publicBaseUrl = (ingress.publicBaseUrl as string) ?? '';
      ctx.send(socket, { type: 'ingress_config_response', publicBaseUrl, localGatewayTarget, success: true });
    } else if (msg.action === 'set') {
      const value = (msg.publicBaseUrl ?? '').trim().replace(/\/+$/, '');
      const raw = loadRawConfig();

      // Update ingress.publicBaseUrl — this is the single source of truth for
      // the canonical public ingress URL. The gateway receives this value via
      // the INGRESS_PUBLIC_BASE_URL env var at spawn time (see hatch.ts).
      // A gateway restart is required for the new value to take effect in
      // inbound Twilio signature validation.
      const ingress = (raw?.ingress ?? {}) as Record<string, unknown>;
      ingress.publicBaseUrl = value || undefined;

      const wasSuppressed = ctx.suppressConfigReload;
      ctx.setSuppressConfigReload(true);
      try {
        saveRawConfig({ ...raw, ingress });
      } catch (err) {
        ctx.setSuppressConfigReload(wasSuppressed);
        throw err;
      }
      const existingSuppressTimer = ctx.debounceTimers.get('__suppress_reset__');
      if (existingSuppressTimer) clearTimeout(existingSuppressTimer);
      const resetTimer = setTimeout(() => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);
      ctx.debounceTimers.set('__suppress_reset__', resetTimer);

      // Propagate to the gateway's process environment so it picks up the
      // new URL on its next config load. For the local-deployment path the
      // gateway runs as a child process that inherited the assistant's env,
      // so updating process.env here ensures the value is visible when the
      // gateway is restarted (e.g. by the self-upgrade skill or a manual
      // `pkill -f gateway`).
      if (value) {
        process.env.INGRESS_PUBLIC_BASE_URL = value;
      } else if (ORIGINAL_INGRESS_ENV !== undefined) {
        process.env.INGRESS_PUBLIC_BASE_URL = ORIGINAL_INGRESS_ENV;
      } else {
        delete process.env.INGRESS_PUBLIC_BASE_URL;
      }

      ctx.send(socket, { type: 'ingress_config_response', publicBaseUrl: value, localGatewayTarget, success: true });
    } else {
      ctx.send(socket, { type: 'ingress_config_response', publicBaseUrl: '', localGatewayTarget, success: false, error: `Unknown action: ${String((msg as unknown as Record<string, unknown>).action)}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.send(socket, { type: 'ingress_config_response', publicBaseUrl: '', localGatewayTarget, success: false, error: message });
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

export function handleEnvVarsRequest(socket: net.Socket, ctx: HandlerContext): void {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) vars[key] = value;
  }
  ctx.send(socket, { type: 'env_vars_response', vars });
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
  env_vars_request: (_msg, socket, ctx) => handleEnvVarsRequest(socket, ctx),
});
