import { type FSWatcher, watch } from "node:fs";

import { Debouncer } from "../util/debounce.js";
import { pathExists } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceHooksDir } from "../util/platform.js";
import { discoverHooks } from "./discovery.js";
import { runHookScript } from "./runner.js";
import type {
  DiscoveredHook,
  HookEventData,
  HookEventName,
  HookTriggerResult,
} from "./types.js";

const log = getLogger("hooks-manager");

/**
 * Legacy event name aliases so existing user hooks that reference the old
 * session-based names still fire when the corresponding conversation event
 * is triggered.
 */
const LEGACY_EVENT_ALIASES: Partial<Record<HookEventName, HookEventName[]>> = {
  "conversation-start": ["session-start"],
  "conversation-end": ["session-end"],
};

export class HookManager {
  private hooks: DiscoveredHook[] = [];
  private eventIndex = new Map<HookEventName, DiscoveredHook[]>();
  private watcher: FSWatcher | null = null;
  private readonly debouncer = new Debouncer(500);

  initialize(): void {
    this.hooks = discoverHooks();
    this.buildEventIndex();
    const enabled = this.hooks.filter((h) => h.enabled).length;
    if (this.hooks.length > 0) {
      log.info({ enabled, total: this.hooks.length }, "Hooks discovered");
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

  async trigger(
    event: HookEventName,
    data: Record<string, unknown>,
  ): Promise<HookTriggerResult> {
    // Collect hooks registered under the canonical event name and any
    // legacy aliases (e.g. session-start -> conversation-start).
    const primaryHooks = this.eventIndex.get(event) ?? [];
    const legacyAliases = LEGACY_EVENT_ALIASES[event] ?? [];
    const aliasHooks = legacyAliases.flatMap(
      (alias) => this.eventIndex.get(alias) ?? [],
    );
    // Deduplicate in case a hook subscribes to both old and new names.
    const seen = new Set<string>();
    const hooks: DiscoveredHook[] = [];
    for (const h of [...primaryHooks, ...aliasHooks]) {
      if (!seen.has(h.name)) {
        seen.add(h.name);
        hooks.push(h);
      }
    }
    if (hooks.length === 0) return { blocked: false };

    const isPreEvent = event.startsWith("pre-");
    const eventData: HookEventData = { ...data, event };

    for (const hook of hooks) {
      try {
        const result = await runHookScript(hook, eventData);
        if (result.exitCode != null && result.exitCode !== 0) {
          // Blocking hooks on pre-* events cancel the action
          if (isPreEvent && hook.manifest.blocking) {
            log.info(
              { hook: hook.name, event, exitCode: result.exitCode },
              "Blocking hook rejected action",
            );
            return { blocked: true, blockedBy: hook.name };
          }
          log.warn(
            { hook: hook.name, event, exitCode: result.exitCode },
            "Hook exited with non-zero code",
          );
        }
      } catch (err) {
        log.warn({ err, hook: hook.name, event }, "Hook execution failed");
      }
    }

    return { blocked: false };
  }

  reload(): void {
    this.hooks = discoverHooks();
    this.buildEventIndex();
    const enabled = this.hooks.filter((h) => h.enabled).length;
    log.info({ enabled, total: this.hooks.length }, "Hooks reloaded");
  }

  watch(): void {
    const hooksDir = getWorkspaceHooksDir();
    if (!pathExists(hooksDir)) return;

    this.stopWatching();

    try {
      this.watcher = watch(
        hooksDir,
        { recursive: true },
        (_eventType, filename) => {
          this.debouncer.schedule(() => {
            log.info(
              { filename: String(filename ?? "") },
              "Hooks directory changed, reloading",
            );
            this.reload();
          });
        },
      );
      log.info({ dir: hooksDir }, "Watching hooks directory for changes");
    } catch (err) {
      log.warn(
        { err, dir: hooksDir },
        "Failed to watch hooks directory. Hot-reload will be unavailable.",
      );
    }
  }

  stopWatching(): void {
    this.debouncer.cancel();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
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
  instance?.stopWatching();
  instance = null;
}
