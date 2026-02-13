import { discoverHooks } from './discovery.js';
import { runHookScript } from './runner.js';
import { getLogger, isDebug } from '../util/logger.js';
import type { DiscoveredHook, HookEventName, HookEventData } from './types.js';

const log = getLogger('hooks-manager');

export class HookManager {
  private hooks: DiscoveredHook[] = [];
  private eventIndex = new Map<HookEventName, DiscoveredHook[]>();

  initialize(): void {
    this.hooks = discoverHooks();
    this.buildEventIndex();
    const enabled = this.hooks.filter((h) => h.enabled).length;
    if (this.hooks.length > 0) {
      log.info({ enabled, total: this.hooks.length }, 'Hooks discovered');
    }
  }

  private buildEventIndex(): void {
    this.eventIndex.clear();
    for (const hook of this.hooks) {
      if (!hook.enabled) continue;
      for (const event of hook.manifest.events) {
        const list = this.eventIndex.get(event) ?? [];
        list.push(hook);
        this.eventIndex.set(event, list);
      }
    }
    // Sort alphabetically by name for deterministic ordering
    for (const [, list] of this.eventIndex) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  async trigger(event: HookEventName, data: Record<string, unknown>): Promise<void> {
    const hooks = this.eventIndex.get(event);
    if (!hooks || hooks.length === 0) return;

    const eventData: HookEventData = { event, ...data };

    for (const hook of hooks) {
      try {
        const result = await runHookScript(hook, eventData);
        if (result.exitCode !== null && result.exitCode !== 0) {
          log.warn({ hook: hook.name, event, exitCode: result.exitCode }, 'Hook exited with non-zero code');
        }
        if (result.stderr && isDebug()) {
          process.stderr.write(result.stderr);
        }
      } catch (err) {
        log.warn({ err, hook: hook.name, event }, 'Hook execution failed');
      }
    }
  }

  getDiscoveredHooks(): DiscoveredHook[] {
    return [...this.hooks];
  }
}

let instance: HookManager | null = null;

export function getHookManager(): HookManager {
  if (!instance) {
    instance = new HookManager();
    instance.initialize();
  }
  return instance;
}

/** Reset the singleton (for testing) */
export function resetHookManager(): void {
  instance = null;
}
