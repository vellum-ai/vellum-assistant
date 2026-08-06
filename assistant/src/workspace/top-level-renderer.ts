import { homedir, userInfo } from "node:os";

import { getIsContainerized } from "../config/env-registry.js";
import type { TopLevelSnapshot } from "./top-level-scanner.js";

// `os.userInfo()` throws `SystemError` when the current UID has no passwd
// entry (possible in sandboxed/containerized envs, including the daemon's
// own container). Guarding here keeps the renderer safe since this runs
// inside the daemon and crashing would break workspace context injection.
function safeUserInfoUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

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
  // The daemon's own `homedir()` / `userInfo()` describe the HOST only when
  // the daemon runs on it. In a container they describe the container, and
  // labelling them "Host …" invites host-side tools (`host_bash`,
  // `host_file_*`, computer use) to be handed a path that exists nowhere on
  // the user's machine. Fall back only when the two are the same machine;
  // otherwise say the value is unknown and name the way to find it, which is
  // cheaper than a failed write on the user's Mac.
  const hostHomeDir =
    options.hostHomeDir ?? (getIsContainerized() ? undefined : homedir());
  const hostUsername =
    options.hostUsername ??
    (getIsContainerized() ? undefined : safeUserInfoUsername());
  lines.push(
    `Host home directory: ${hostHomeDir ?? "unknown (ask the host shell: `host_bash` with `echo $HOME`)"}`,
  );
  lines.push(`Host username: ${hostUsername ?? "unknown"}`);
  lines.push("</workspace>");
  return lines.join("\n");
}
