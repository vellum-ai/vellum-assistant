import { initializeProviders } from '../providers/registry.js';
import { initializeTools } from '../tools/registry.js';
import { registerWatcherProvider } from '../watcher/provider-registry.js';
import { gmailProvider } from '../watcher/providers/gmail.js';
import { googleCalendarProvider } from '../watcher/providers/google-calendar.js';
import { slackProvider as slackWatcherProvider } from '../watcher/providers/slack.js';
import { githubProvider } from '../watcher/providers/github.js';
import { linearProvider } from '../watcher/providers/linear.js';
import { registerMessagingProvider } from '../messaging/registry.js';
import { slackProvider as slackMessagingProvider } from '../messaging/providers/slack/adapter.js';
import { gmailMessagingProvider } from '../messaging/providers/gmail/adapter.js';
import { telegramBotMessagingProvider } from '../messaging/providers/telegram-bot/adapter.js';
import { smsMessagingProvider } from '../messaging/providers/sms/adapter.js';
import { whatsappMessagingProvider } from '../messaging/providers/whatsapp/adapter.js';
import { initWatcherEngine } from '../watcher/engine.js';
import type { AssistantConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('lifecycle');

export async function initializeProvidersAndTools(config: AssistantConfig): Promise<void> {
  log.info('Daemon startup: initializing providers and tools');
  initializeProviders(config);
  await initializeTools();
  log.info('Daemon startup: providers and tools initialized');
}

export function registerWatcherProviders(): void {
  registerWatcherProvider(gmailProvider);
  registerWatcherProvider(googleCalendarProvider);
  registerWatcherProvider(slackWatcherProvider);
  registerWatcherProvider(githubProvider);
  registerWatcherProvider(linearProvider);
  initWatcherEngine();
}

export function registerMessagingProviders(): void {
  registerMessagingProvider(slackMessagingProvider);
  registerMessagingProvider(gmailMessagingProvider);
  registerMessagingProvider(telegramBotMessagingProvider);
  registerMessagingProvider(smsMessagingProvider);
  registerMessagingProvider(whatsappMessagingProvider);
}
