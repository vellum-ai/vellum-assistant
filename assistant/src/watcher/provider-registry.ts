import type { WatcherProvider } from './provider-types.js';

const providers = new Map<string, WatcherProvider>();

export function registerWatcherProvider(provider: WatcherProvider): void {
  providers.set(provider.id, provider);
}

export function getWatcherProvider(id: string): WatcherProvider | undefined {
  return providers.get(id);
}

export function listWatcherProviders(): WatcherProvider[] {
  return Array.from(providers.values());
}
