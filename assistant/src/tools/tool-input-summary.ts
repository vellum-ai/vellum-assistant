/**
 * Summarizes tool input into a concise string for guardian approval display.
 *
 * The summary is shown only to the guardian who already has full access,
 * so no secret masking is applied.
 */

function truncate(value: string, maxLen: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}…`;
}

function extractString(
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const val = input[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return val;
    }
  }
  return undefined;
}

function firstStringValue(input: Record<string, unknown>): string | undefined {
  for (const val of Object.values(input)) {
    if (typeof val === "string" && val.trim().length > 0) {
      return val;
    }
  }
  return undefined;
}

export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "bash":
    case "terminal": {
      const cmd = extractString(input, "command");
      return cmd ? truncate(cmd, 120) : "";
    }
    case "file_read":
    case "file_write":
    case "file_edit": {
      const path = extractString(input, "file_path", "path");
      return path ? path.trim() : "";
    }
    case "web_fetch":
    case "network_request": {
      const url = extractString(input, "url");
      return url ? truncate(url, 100) : "";
    }
    default: {
      const fallback = firstStringValue(input);
      return fallback ? truncate(fallback, 80) : "";
    }
  }
}
