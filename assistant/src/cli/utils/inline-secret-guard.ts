import type { Command } from "commander";

import { writeError } from "../output.js";
import { tryResolveConversationId } from "./conversation-id.js";

/**
 * Agent-shell guard for CLI commands that accept a secret inline. A
 * conversation ID in the environment means the process was spawned by the
 * agent bash tool or skill sandbox, so an inline value likely transited the
 * conversation and would persist unredacted in the transcript.
 *
 * When that holds and `--generated` was not passed, writes a refusal (the
 * shared preamble, the command's `redirect` to a secure collection path, and
 * the `--generated` escape hatch), sets exit code 1, and returns true — the
 * caller must abort without storing anything. Returns false when the store
 * may proceed (user terminal, or a machine-obtained value asserted via
 * `--generated`).
 */
export function refuseAgentShellInlineSecret(
  cmd: Command,
  opts: { generated?: boolean },
  { what, redirect }: { what: string; redirect: string },
): boolean {
  if (tryResolveConversationId() === undefined || opts.generated) {
    return false;
  }
  writeError(
    cmd,
    `Refusing to store an inline ${what} from an agent shell: the value likely transited the conversation and would persist in the transcript. ` +
      `${redirect} ` +
      `If the value was machine-obtained by the agent itself (e.g. "$(uuidgen)" or an API exchange result) and was never typed or pasted by the user, re-run with --generated.`,
  );
  process.exitCode = 1;
  return true;
}
