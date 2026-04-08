import { homedir, userInfo } from "node:os";

import type { TopLevelSnapshot } from "./top-level-scanner.js";

export interface WorkspaceTopLevelRenderOptions {
  conversationAttachmentsPath?: string | null;
  /**
   * Host home directory on the client machine. When provided, takes
   * precedence over the daemon's own `os.homedir()`. This matters for
   * platform-managed (containerized) daemons where `os.homedir()` returns
   * the container's home, not the user's actual Mac.
   */
  hostHomeDir?: string;
  /**
   * Host username on the client machine. When provided, takes precedence
   * over the daemon's own `os.userInfo().username`. See `hostHomeDir`.
   */
  hostUsername?: string;
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
    lines.push(
      `Current conversation attachments: ${options.conversationAttachmentsPath}`,
    );
  }
  if (snapshot.truncated) {
    lines.push("(list truncated — more entries exist)");
  }
  lines.push(`Host home directory: ${options.hostHomeDir ?? homedir()}`);
  lines.push(`Host username: ${options.hostUsername ?? userInfo().username}`);
  lines.push("</workspace>");
  return lines.join("\n");
}
