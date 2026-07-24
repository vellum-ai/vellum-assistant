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
 * email's "jump back in" link should re-open, or `null`. The assistant chooses
 * it: the prompt offers a list of the owner's recent conversations and asks it
 * to name the one its email is about, and the route returns that id only after
 * validating it against the offered set. See {@link conversationCandidates}.
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

function buildPrompt(
  outputPath: string,
  candidates: ConversationCandidate[],
): string {
  const conversationList =
    candidates.length > 0
      ? candidates.map((c) => `- ${c.id}: ${c.title}`).join("\n")
      : "(you have no recent conversations)";

  return `Compose a short re-engagement email to me, in your own voice as my assistant, to gently draw me back into our work together.

Draw on what you know about me and our recent conversations to make it personal and specific — reference something concrete we have been working on, or a next step that is waiting on me, rather than a generic "just checking in." Keep it warm, brief, and low-pressure: a few sentences at most, with no pushy or salesy language.

When the email is ready, use your file-writing tool to write it to exactly this path:

\`${outputPath}\`

Write ONLY a raw JSON object to that file — no markdown, no code fence, no surrounding prose — with exactly these fields:
{"subject": "<the subject line>", "body": "<the plain-text email body>", "conversation": "<id or null>"}

The subject should be short and specific. The body is the email itself, written as if you are speaking directly to me.

For "conversation", choose the one conversation below that your email is about — the thread I should re-open to pick up where we left off — and use its id exactly as written. If none of them fit what your email references, use null. Never invent an id; only use one from this list:
${conversationList}

The file is the deliverable; do not include the email in your chat reply.`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface ParsedEmail {
  subject: string;
  body: string;
  /** The conversation id the assistant chose, or `null` for none. */
  conversation: string | null;
}

/**
 * Read `{ subject, body, conversation }` out of the JSON the assistant wrote.
 * The instruction asks for a bare object, but tolerate a stray code fence or
 * surrounding prose by falling back to the first brace-delimited span.
 *
 * `conversation` is optional and the id it names is not trusted here — the
 * handler validates it against the offered candidates. A missing value, JSON
 * `null`, or the literal string `"null"` all normalize to `null`.
 */
function parseEmail(raw: string): ParsedEmail | null {
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
          const raw =
            typeof record.conversation === "string"
              ? record.conversation.trim()
              : "";
          const conversation = raw && raw !== "null" ? raw : null;
          return { subject, body, conversation };
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
// Conversation candidates for the "jump back in" link
// ---------------------------------------------------------------------------

/** A conversation the assistant may choose to link the email back to. */
interface ConversationCandidate {
  id: string;
  title: string;
}

/** How many recent conversations to offer the assistant to choose from. */
const CANDIDATE_LIMIT = 10;

/**
 * Recent, genuinely-standard conversations the assistant can pick from for the
 * email's "jump back in" link.
 *
 * The assistant chooses which conversation the email is about (see
 * {@link buildPrompt}), but it has no reliable handle on raw conversation ids —
 * there is no list/search-conversations tool and ids are not in its context —
 * so we hand it real candidates to choose among and validate its pick against
 * this set, rather than trusting a free-formed (hallucinatable) id.
 *
 * `listConversations(…, "standard")` also surfaces background/scheduled rows
 * that were promoted via `surfaced_at`, which are not real chats to re-open, so
 * the result is filtered to rows whose type is actually `"standard"`. That also
 * excludes the drafting turn's own background conversation.
 */
async function conversationCandidates(): Promise<ConversationCandidate[]> {
  const rows = await listConversations(CANDIDATE_LIMIT * 2, "standard");
  return rows
    .filter((row) => row.conversationType === "standard")
    .slice(0, CANDIDATE_LIMIT)
    .map((row) => ({ id: row.id, title: row.title?.trim() || "Untitled" }));
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const POST = async (request: Request): Promise<Response> => {
  const dir = pluginDataDir();
  await mkdir(dir, { recursive: true });
  const outputPath = join(dir, `reengage-${crypto.randomUUID()}.json`);

  // Offer the assistant real conversations to choose the "jump back in" link
  // from, so the id it writes can be validated against actual chats.
  const candidates = await conversationCandidates();

  try {
    await runConversationTurn({
      content: [{ type: "text", text: buildPrompt(outputPath, candidates) }],
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

    // Trust the assistant's choice only if it names one of the conversations we
    // offered — never a free-formed id. The platform wraps `body` in a template
    // whose CTA deep-links to this conversation when present, else the
    // assistant root.
    const candidateIds = new Set(candidates.map((c) => c.id));
    const conversation =
      email.conversation && candidateIds.has(email.conversation)
        ? email.conversation
        : null;
    return Response.json({
      subject: email.subject,
      body: email.body,
      conversation,
    });
  } finally {
    await rm(outputPath, { force: true });
  }
};
