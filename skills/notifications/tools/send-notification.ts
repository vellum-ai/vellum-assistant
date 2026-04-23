/**
 * CLI shim for the send_notification tool.
 *
 * Spawns `assistant notifications send --json` with the appropriate flags,
 * which delegates to the daemon via IPC. This eliminates the tool's
 * dependency on assistant internals and makes the skill fully portable.
 */

export async function run(
  input: Record<string, unknown>,
  _context: { workingDir: string; conversationId: string },
): Promise<{ content: string; isError: boolean }> {
  const args: string[] = [
    "notifications",
    "send",
    "--json",
    "--source-channel",
    "assistant_tool",
    "--source-event-name",
    typeof input.source_event_name === "string" && input.source_event_name
      ? input.source_event_name
      : "user.send_notification",
    "--message",
    String(input.message ?? ""),
  ];

  // Optional string flags
  if (typeof input.title === "string" && input.title) {
    args.push("--title", input.title);
  }
  if (typeof input.urgency === "string" && input.urgency) {
    args.push("--urgency", input.urgency);
  }
  if (input.deadline_at != null) {
    args.push("--deadline-at", String(input.deadline_at));
  }
  if (typeof input.dedupe_key === "string" && input.dedupe_key) {
    args.push("--dedupe-key", input.dedupe_key);
  }
  if (typeof input.conversation_id === "string" && input.conversation_id) {
    args.push("--session-id", input.conversation_id);
  }
  if (Array.isArray(input.preferred_channels) && input.preferred_channels.length > 0) {
    args.push("--preferred-channels", input.preferred_channels.join(","));
  }

  // Boolean flags
  if (typeof input.requires_action === "boolean") {
    args.push(input.requires_action ? "--requires-action" : "--no-requires-action");
  }
  if (typeof input.is_async_background === "boolean") {
    args.push(
      input.is_async_background ? "--is-async-background" : "--no-is-async-background",
    );
  }
  if (typeof input.visible_in_source_now === "boolean") {
    args.push(
      input.visible_in_source_now
        ? "--visible-in-source-now"
        : "--no-visible-in-source-now",
    );
  }

  try {
    const proc = Bun.spawn(["assistant", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    try {
      const result = JSON.parse(stdout) as { ok: boolean; error?: string };
      if (result.ok) {
        return {
          content:
            "Notification request queued. Channel selection and delivery are handled by the notification router.",
          isError: false,
        };
      }
      return { content: result.error ?? "Unknown error", isError: true };
    } catch {
      // stdout wasn't valid JSON
      if (exitCode !== 0) {
        return {
          content: `Notification send failed (exit ${exitCode}): ${stdout.trim()}`,
          isError: true,
        };
      }
      return { content: stdout.trim() || "Unknown error", isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Failed to spawn assistant CLI: ${message}`, isError: true };
  }
}
