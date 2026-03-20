import {
  setPlatformAssistantId,
  setPlatformBaseUrl,
  setPlatformOrganizationId,
  setPlatformUserId,
} from "../config/env.js";
import type { AssistantConfig } from "../config/types.js";
import { setSentryOrganizationId, setSentryUserId } from "../instrument.js";
import { getMcpServerManager } from "../mcp/manager.js";
import { gmailMessagingProvider } from "../messaging/providers/gmail/adapter.js";
import { slackProvider as slackMessagingProvider } from "../messaging/providers/slack/adapter.js";
import { telegramBotMessagingProvider } from "../messaging/providers/telegram-bot/adapter.js";
import { whatsappMessagingProvider } from "../messaging/providers/whatsapp/adapter.js";
import { registerMessagingProvider } from "../messaging/registry.js";
import { initializeProviders } from "../providers/registry.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { createMcpToolsFromServer } from "../tools/mcp/mcp-tool-factory.js";
import { initializeTools, registerMcpTools } from "../tools/registry.js";
import { getLogger } from "../util/logger.js";
import { initWatcherEngine } from "../watcher/engine.js";
import { registerWatcherProvider } from "../watcher/provider-registry.js";
import { githubProvider } from "../watcher/providers/github.js";
import { gmailProvider } from "../watcher/providers/gmail.js";
import { googleCalendarProvider } from "../watcher/providers/google-calendar.js";
import { linearProvider } from "../watcher/providers/linear.js";
const log = getLogger("lifecycle");

export async function initializeProvidersAndTools(
  config: AssistantConfig,
): Promise<void> {
  log.info("Daemon startup: initializing providers and tools");

  // Rehydrate the platform base URL from the credential store so managed
  // proxy activation survives assistant restarts. The in-memory override is
  // normally only set by handleAddSecret/handleDeleteSecret at runtime.
  try {
    const key = credentialKey("vellum", "platform_base_url");
    const { value: persisted } = await getSecureKeyAsync(key);
    if (persisted) {
      setPlatformBaseUrl(persisted);
      log.info("Rehydrated platform base URL from credential store");
    }
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to rehydrate platform base URL from credential store (non-fatal)",
    );
  }

  // Rehydrate the platform assistant ID from the credential store so
  // shouldUsePlatformCallbacks() works after assistant restarts.
  try {
    const key = credentialKey("vellum", "platform_assistant_id");
    const { value: persisted } = await getSecureKeyAsync(key);
    const trimmed = persisted?.trim();
    if (trimmed) {
      setPlatformAssistantId(trimmed);
      log.info("Rehydrated platform assistant ID from credential store");
    }
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to rehydrate platform assistant ID from credential store (non-fatal)",
    );
  }

  // Rehydrate the platform organization ID from the credential store so
  // Sentry events include organization context after restarts.
  try {
    const key = credentialKey("vellum", "platform_organization_id");
    const { value: persisted } = await getSecureKeyAsync(key);
    const trimmed = persisted?.trim();
    if (trimmed) {
      setPlatformOrganizationId(trimmed);
      setSentryOrganizationId(trimmed);
      log.info("Rehydrated platform organization ID from credential store");
    }
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to rehydrate platform organization ID from credential store (non-fatal)",
    );
  }

  // Rehydrate the platform user ID from the credential store so
  // telemetry events include user context after restarts.
  try {
    const key = credentialKey("vellum", "platform_user_id");
    const { value: persisted } = await getSecureKeyAsync(key);
    const trimmed = persisted?.trim();
    if (trimmed) {
      setPlatformUserId(trimmed);
      setSentryUserId(trimmed);
      log.info("Rehydrated platform user ID from credential store");
    }
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to rehydrate platform user ID from credential store (non-fatal)",
    );
  }

  await initializeProviders(config);
  await initializeTools();

  // Start MCP servers and register their tools
  if (config.mcp?.servers && Object.keys(config.mcp.servers).length > 0) {
    const manager = getMcpServerManager();
    try {
      const serverToolInfos = await manager.start(config.mcp);
      for (const { serverId, serverConfig, tools } of serverToolInfos) {
        const mcpTools = createMcpToolsFromServer(
          tools,
          serverId,
          serverConfig,
          manager,
        );
        registerMcpTools(mcpTools);
      }
    } catch (err) {
      log.error(
        { err },
        "MCP server initialization failed — continuing without MCP tools",
      );
    }
  }

  log.info("Daemon startup: providers and tools initialized");
}

export function registerWatcherProviders(): void {
  registerWatcherProvider(gmailProvider);
  registerWatcherProvider(googleCalendarProvider);
  registerWatcherProvider(githubProvider);
  registerWatcherProvider(linearProvider);
  initWatcherEngine();
}

export function registerMessagingProviders(): void {
  registerMessagingProvider(slackMessagingProvider);
  registerMessagingProvider(gmailMessagingProvider);
  registerMessagingProvider(telegramBotMessagingProvider);
  registerMessagingProvider(whatsappMessagingProvider);
}
