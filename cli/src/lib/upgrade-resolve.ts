import {
  findAssistantByName,
  getActiveAssistant,
  loadAllAssistants,
} from "./assistant-config.js";
import type { AssistantEntry } from "./assistant-config.js";
import {
  fetchAssistantByIdFromPlatform,
  getPlatformUrl,
  readPlatformToken,
} from "./platform-client.js";
import { emitCliError } from "./cli-error.js";

/**
 * Resolve which assistant to target for the upgrade command. Priority:
 * 1. Explicit name argument
 * 2. Active assistant set via `vellum use`
 * 3. Sole assistant (when exactly one exists)
 */
export async function resolveTargetAssistant(
  nameArg: string | null,
): Promise<AssistantEntry> {
  if (nameArg) {
    const entry = findAssistantByName(nameArg);
    if (entry) return entry;

    // Local lockfile miss. The macOS app stores its lockfile in a
    // sandboxed container the CLI can't read, so a platform-managed
    // assistant identified by UUID won't be found locally even though
    // it exists. If we have a platform token, try resolving the name
    // against the platform API and synthesize an in-memory entry.
    const token = readPlatformToken();
    if (!token) {
      console.error(`No assistant found with name '${nameArg}'.`);
      emitCliError(
        "ASSISTANT_NOT_FOUND",
        `No assistant found with name '${nameArg}'.`,
      );
      process.exit(1);
    }

    let platformAssistant;
    try {
      platformAssistant = await fetchAssistantByIdFromPlatform(token, nameArg);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (detail.includes("Authentication failed")) {
        // authHeaders already printed the user-facing
        // "Authentication failed…" line to stderr before re-throwing; emit
        // only the structured CLI_ERROR here to avoid a duplicate log.
        emitCliError(
          "AUTH_FAILED",
          `Authentication failed while looking up assistant '${nameArg}'. Run 'vellum login' to refresh.`,
          detail,
        );
      } else {
        const msg = `Failed to look up assistant '${nameArg}' on the platform: ${detail}`;
        console.error(msg);
        emitCliError("PLATFORM_API_ERROR", msg, detail);
      }
      process.exit(1);
    }
    if (!platformAssistant) {
      const msg = `No local or platform assistant found with name '${nameArg}'. Make sure you are logged in and this assistant belongs to your account.`;
      console.error(msg);
      emitCliError("ASSISTANT_NOT_FOUND", msg);
      process.exit(1);
    }

    // Defensive: the platform helper casts JSON without runtime validation,
    // so a 200 with a malformed body could yield an object whose `id` is
    // `undefined`. Reject that explicitly rather than letting `undefined`
    // flow into the upgrade POST body's `assistant_id` field.
    if (!platformAssistant.id) {
      const msg = `Platform returned a malformed response for assistant '${nameArg}'.`;
      console.error(msg);
      emitCliError("PLATFORM_API_ERROR", msg);
      process.exit(1);
    }

    // Use the canonical id from the platform response rather than the raw
    // user input (which may differ in casing/whitespace). Subsequent code
    // uses `entry.assistantId` to construct the upgrade POST body's
    // `assistant_id` field — trusting user input over the server-confirmed
    // id is a footgun.
    return {
      assistantId: platformAssistant.id,
      cloud: "vellum",
      runtimeUrl: getPlatformUrl(),
    };
  }

  const active = getActiveAssistant();
  if (active) {
    const entry = findAssistantByName(active);
    if (entry) return entry;
  }

  const all = loadAllAssistants();
  if (all.length === 1) return all[0];

  if (all.length === 0) {
    const msg = "No assistants found. Run 'vellum hatch' first.";
    console.error(msg);
    emitCliError("ASSISTANT_NOT_FOUND", msg);
  } else {
    const msg =
      "Multiple assistants found. Specify a name or set an active assistant with 'vellum use <name>'.";
    console.error(msg);
    emitCliError("ASSISTANT_NOT_FOUND", msg);
  }
  process.exit(1);
}
