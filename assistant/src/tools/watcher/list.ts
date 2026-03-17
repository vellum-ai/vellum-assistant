import {
  getWatcher,
  listWatcherEvents,
  listWatchers,
} from "../../watcher/watcher-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeWatcherList(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const watcherId = input.watcher_id as string | undefined;
  const enabledOnly = (input.enabled_only as boolean) ?? false;

  if (watcherId) {
    const watcher = getWatcher(watcherId);
    if (!watcher) {
      return {
        content: `Error: Watcher not found: ${watcherId}`,
        isError: true,
      };
    }

    const events = listWatcherEvents({ watcherId, limit: 10 });
    const lines = [
      `Watcher: ${watcher.name}`,
      `  ID: ${watcher.id}`,
      `  Provider: ${watcher.providerId}`,
      `  Status: ${watcher.status}`,
      `  Enabled: ${watcher.enabled}`,
      `  Poll interval: ${Math.round(watcher.pollIntervalMs / 1000)}s`,
      `  Credential: ${watcher.credentialService}`,
      `  Last poll: ${
        watcher.lastPollAt
          ? new Date(watcher.lastPollAt).toLocaleString()
          : "never"
      }`,
      `  Next poll: ${
        watcher.nextPollAt
          ? new Date(watcher.nextPollAt).toLocaleString()
          : "n/a"
      }`,
      `  Errors: ${watcher.consecutiveErrors}`,
    ];

    if (watcher.lastError) {
      lines.push(`  Last error: ${watcher.lastError}`);
    }

    if (events.length > 0) {
      lines.push("", `Recent events (${events.length}):`);
      for (const event of events) {
        lines.push(
          `  - [${event.disposition}] ${event.summary} (${new Date(
            event.createdAt,
          ).toLocaleString()})`,
        );
      }
    } else {
      lines.push("", "No events detected yet.");
    }

    return { content: lines.join("\n"), isError: false };
  }

  const allWatchers = listWatchers({ enabledOnly });
  if (allWatchers.length === 0) {
    return { content: "No watchers found.", isError: false };
  }

  const lines = [`Watchers (${allWatchers.length}):`];
  for (const w of allWatchers) {
    const status = w.enabled ? w.status : "disabled";
    const lastPoll = w.lastPollAt
      ? new Date(w.lastPollAt).toLocaleString()
      : "never";
    lines.push(
      `  - [${status}] ${w.name} (${w.providerId}) - last: ${lastPoll}`,
    );
  }

  return { content: lines.join("\n"), isError: false };
}
