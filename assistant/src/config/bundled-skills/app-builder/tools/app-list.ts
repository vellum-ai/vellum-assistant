import * as appStore from "../../../../memory/app-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

interface AppListEntry {
  app_id: string;
  name: string;
  description?: string;
  updated_at: number;
  created_at: number;
}

function toEntry(app: appStore.AppDefinition): AppListEntry {
  return {
    app_id: app.id,
    name: app.name,
    ...(app.description ? { description: app.description } : {}),
    updated_at: app.updatedAt,
    created_at: app.createdAt,
  };
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const apps = appStore.listApps();
  const entries = apps.map(toEntry);

  const query =
    typeof input.query === "string" ? input.query.trim().toLowerCase() : "";

  if (!query) {
    return {
      content: JSON.stringify({ count: entries.length, apps: entries }),
      isError: false,
    };
  }

  // Resolve the app the user mentioned by name. Prefer an exact (case-insensitive)
  // name match, then fall back to substring matches in either direction so
  // "habit tracker" resolves "Habit Tracker" and "my budget" resolves "Budget".
  const exact = entries.filter((e) => e.name.toLowerCase() === query);
  const matches =
    exact.length > 0
      ? exact
      : entries.filter((e) => {
          const name = e.name.toLowerCase();
          return name.includes(query) || query.includes(name);
        });

  return {
    content: JSON.stringify({
      query: input.query,
      match_count: matches.length,
      matches,
    }),
    isError: false,
  };
}
