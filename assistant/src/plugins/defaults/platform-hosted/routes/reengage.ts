/**
 * Platform-hosted `/reengage` route.
 *
 * Authored in the userland plugin route format (`export const POST`, standard
 * Web `Request`/`Response`) so it is served as-is once the assistant dispatches
 * default-plugin routes.
 *
 * The handler runs a full background conversation turn (via
 * `runConversationTurn`) so the assistant's identity, memory, and history are
 * all in scope while it composes a short re-engagement email in its own voice.
 * The turn has no way to return typed data, so the route injects an output file
 * path into the prompt and asks the assistant to write `{ subject, body }` JSON
 * there; the route then reads that file back, so the subject and body are read
 * from structured JSON rather than parsed out of the chat reply. The turn runs
 * in a fresh `background` conversation, so it stays out of the user's visible
 * chats.
 *
 * The response also carries `conversation` — the id of the conversation the
 * email's "jump back in" link should re-open (the owner's most recent standard
 * conversation, or `null`). It is resolved server-side rather than asked of the
 * model; see {@link conversationToReopen}.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  getWorkspaceDir,
  listConversations,
  runConversationTurn,
} from "@vellumai/plugin-api";

// ---------------------------------------------------------------------------
// Output location — the plugin's own data directory
// ---------------------------------------------------------------------------

/** `<workspaceDir>/plugins/platform-hosted/data` — this plugin's runtime data dir. */
function pluginDataDir(): string {
  return join(getWorkspaceDir(), "plugins", "platform-hosted", "data");
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(outputPath: string): string {
  return `Compose a short re-engagement email to me, in your own voice as my assistant, to gently draw me back into our work together.

Draw on what you know about me and our recent conversations to make it personal and specific — reference something concrete we have been working on, or a next step that is waiting on me, rather than a generic "just checking in." Keep it warm, brief, and low-pressure: a few sentences at most, with no pushy or salesy language.

When the email is ready, use your file-writing tool to write it to exactly this path:

\`${outputPath}\`

Write ONLY a raw JSON object to that file — no markdown, no code fence, no surrounding prose — with exactly these two string fields:
{"subject": "<the subject line>", "body": "<the plain-text email body>"}

The subject should be short and specific. The body is the email itself, written as if you are speaking directly to me. The file is the deliverable; do not include the email in your chat reply.`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Read `{ subject, body }` out of the JSON the assistant wrote. The instruction
 * asks for a bare object, but tolerate a stray code fence or surrounding prose
 * by falling back to the first brace-delimited span.
 */
function parseEmail(raw: string): { subject: string; body: string } | null {
  const candidates = [raw.trim()];
  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace?.[0]) {
    candidates.push(brace[0]);
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        const subject =
          typeof record.subject === "string" ? record.subject.trim() : "";
        const body = typeof record.body === "string" ? record.body.trim() : "";
        if (subject && body) {
          return { subject, body };
        }
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: { message } }, { status });
}

// ---------------------------------------------------------------------------
// Conversation to re-open
// ---------------------------------------------------------------------------

/**
 * The conversation the email's "jump back in" link should target: the owner's
 * most recent standard (user-facing) conversation, or `null` when there is
 * none yet.
 *
 * Server-derived on purpose. The email body is drafted by the model, but the
 * assistant has no reliable handle on conversation ids — there is no
 * list/search-conversations tool and ids are not in its context — so asking it
 * to name one in the JSON would invite a hallucinated id. The `standard`
 * listing already excludes background/scheduled/subagent rows (so the drafting
 * turn's own background conversation is never selected) and is ordered by most
 * recent activity, which is exactly "where we left off".
 */
async function conversationToReopen(): Promise<string | null> {
  const [recent] = await listConversations(1, "standard");
  return recent?.id ?? null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const POST = async (request: Request): Promise<Response> => {
  const dir = pluginDataDir();
  await mkdir(dir, { recursive: true });
  const outputPath = join(dir, `reengage-${crypto.randomUUID()}.json`);

  try {
    await runConversationTurn({
      content: [{ type: "text", text: buildPrompt(outputPath) }],
      conversationType: "background",
      // Drafting a short email is latency-bound, not depth-bound, so run it on
      // the fast model rather than the balanced main-agent default. `inference`
      // is the general-purpose call site plugins use for exactly this — it
      // resolves to the Speed (cost-optimized) profile — so we reuse it instead
      // of teaching the daemon about a reengagement-specific call site.
      callSite: "inference",
      signal: request.signal,
    });

    let raw: string;
    try {
      raw = await readFile(outputPath, "utf8");
    } catch {
      return jsonError(
        "The re-engagement turn did not write an email file.",
        502,
      );
    }

    const email = parseEmail(raw);
    if (!email) {
      return jsonError(
        "The re-engagement email file did not contain a usable subject and body.",
        502,
      );
    }

    // The platform wraps `body` in a template whose CTA deep-links to this
    // conversation when present, or the assistant root when null.
    const conversation = await conversationToReopen();
    return Response.json({ ...email, conversation });
  } finally {
    await rm(outputPath, { force: true });
  }
};
