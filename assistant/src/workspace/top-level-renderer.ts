import type { TopLevelSnapshot } from "./top-level-scanner.js";

export interface WorkspaceTopLevelRenderOptions {
  conversationAttachmentsPath?: string | null;
}

/**
 * Render a workspace top-level snapshot into a compact XML-like block
 * suitable for injection into user messages.
 *
 * Output is stable for equal input and kept concise to minimize token cost.
 */
export function renderWorkspaceTopLevelContext(
  snapshot: TopLevelSnapshot,
  options: WorkspaceTopLevelRenderOptions = {},
): string {
  const lines: string[] = ["<workspace>"];
  lines.push(`Root: ${snapshot.rootPath}`);
  lines.push(`Directories: ${snapshot.directories.join(", ")}`);
  lines.push(`Files: ${snapshot.files.join(", ")}`);
  if (options.conversationAttachmentsPath) {
    lines.push(`Current conversation attachments: ${options.conversationAttachmentsPath}`);
  }
  if (snapshot.truncated) {
    lines.push("(list truncated — more entries exist)");
  }
  lines.push("</workspace>");
  return lines.join("\n");
}
