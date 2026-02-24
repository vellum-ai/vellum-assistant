import * as net from 'node:net';
import { getConfig, loadRawConfig, saveRawConfig } from '../../config/loader.js';
import { initializeProviders } from '../../providers/registry.js';
import type {
  ModelSetRequest,
  ImageGenModelSetRequest,
} from '../ipc-protocol.js';
import { log, CONFIG_RELOAD_DEBOUNCE_MS, defineHandlers, type HandlerContext } from './shared.js';
import { MODEL_TO_PROVIDER } from '../session-slash.js';

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

export const modelHandlers = defineHandlers({
  model_get: (_msg, socket, ctx) => handleModelGet(socket, ctx),
  model_set: handleModelSet,
  image_gen_model_set: handleImageGenModelSet,
});
