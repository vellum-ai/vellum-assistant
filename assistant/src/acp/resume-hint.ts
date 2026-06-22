/**
 * Shared `claude --resume` hint for ACP sessions.
 *
 * `claude --resume <id>` is Claude Code-specific (the claude-agent-acp
 * adapter binary). Other adapters resume differently or not at all, so the
 * hint is gated by the resolved adapter, not the agent id - this stays
 * correct when a user aliases an id to a different binary. Callers pass the
 * resolved command basename, which is always the real adapter binary.
 *
 * Used by the `acp_spawn` tool's success payload and the session manager's
 * completion notification so both surfaces render identical copy. Returns
 * an empty string for non-claude adapters; callers add their own
 * surrounding separators.
 */
export function claudeResumeHint(
  command: string,
  cwd: string,
  sessionId: string,
): string {
  return command === "claude-agent-acp"
    ? `To resume: cd ${cwd} && claude --resume ${sessionId}`
    : "";
}
