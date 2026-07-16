/**
 * Platform-hosted `/reengage` route.
 *
 * Authored in the userland plugin route format (`export const POST`,
 * standard Web `Request`/`Response`, imports from `@vellumai/plugin-api`) so
 * that once the assistant serves default-plugin routes through the `/x/*`
 * dispatcher this file is served as-is with no changes. Until then it is
 * bridged into the shared route table by the sibling `register.ts`.
 *
 * The handler runs a background conversation turn asking the assistant to
 * compose a short re-engagement email in its own voice, then returns the
 * parsed `{ subject, body }` (plus the `conversationId` of the background
 * turn) so the platform can send it to the user. The turn runs in a fresh
 * `background` conversation, so the assistant's identity, memory, and history
 * are all in scope while the prompt and reply stay out of the user's visible
 * chats.
 */

import {
  type ContentBlock,
  runConversationTurn,
  type TextContent,
} from "@vellumai/plugin-api";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Instruction for the background turn. Asks the assistant to write, in its own
 * voice, a short re-engagement email to the user and to return it as a JSON
 * object so the subject and body can be extracted deterministically.
 */
const REENGAGE_PROMPT = `Write a short re-engagement email to me, in your own voice as my assistant, to gently draw me back into our work together.

Draw on what you know about me and our recent conversations to make it personal and specific — reference something concrete we have been working on, or a next step that is waiting on me, rather than a generic "just checking in." Keep it warm, brief, and low-pressure: a few sentences at most, no pushy or salesy language.

Respond with ONLY a JSON object of the form:
{"subject": "<the email subject line>", "body": "<the plain-text email body>"}

The subject should be a short, specific line that would make me want to open it. The body is the email itself, written as if you are speaking directly to me. Do not include any text outside the JSON object.`;

// ---------------------------------------------------------------------------
// Schemas — also consumed by register.ts for the OpenAPI contract
// ---------------------------------------------------------------------------

export const ReengageRequestSchema = z.object({
  /**
   * Extra guidance appended to the base instruction — e.g. a campaign angle or
   * a specific thread the platform wants the email to reference.
   */
  additionalGuidance: z.string().optional(),
});

export const ReengageResponseSchema = z.object({
  subject: z.string(),
  body: z.string(),
  conversationId: z.string(),
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Concatenate the text blocks of an assistant response into one string. */
function joinAssistantText(content: ContentBlock[]): string {
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Extract `{ subject, body }` from the assistant's response text.
 *
 * The prompt asks for a bare JSON object, but models occasionally wrap it in a
 * code fence or add stray prose, so this tries the fenced block and the first
 * brace-delimited span before falling back to treating the first non-empty
 * line as the subject and the remainder as the body.
 */
function parseReengagement(
  text: string,
): { subject: string; body: string } | null {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }
  const brace = text.match(/\{[\s\S]*\}/);
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
      // Not valid JSON — try the next candidate.
    }
  }

  const lines = text.split("\n").map((line) => line.trim());
  const firstIdx = lines.findIndex((line) => line.length > 0);
  if (firstIdx === -1) {
    return null;
  }
  const subject = lines[firstIdx];
  const body = lines
    .slice(firstIdx + 1)
    .join("\n")
    .trim();
  if (!body) {
    return null;
  }
  return { subject, body };
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: { message } }, { status });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const POST = async (request: Request): Promise<Response> => {
  let rawBody: unknown = {};
  try {
    const text = await request.text();
    if (text.trim()) {
      rawBody = JSON.parse(text);
    }
  } catch {
    return jsonError("Request body must be valid JSON.", 400);
  }

  const parsedBody = ReengageRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return jsonError("Invalid request body.", 400);
  }
  const { additionalGuidance } = parsedBody.data;

  const promptText = additionalGuidance
    ? `${REENGAGE_PROMPT}\n\nAdditional guidance for this email:\n${additionalGuidance}`
    : REENGAGE_PROMPT;

  // Always run in a fresh background conversation (no caller-supplied
  // conversationId): only a newly created conversation honors
  // `conversationType: "background"`, so this keeps the prompt and generated
  // reply out of the user's visible chats. A fresh conversation is never busy,
  // so the turn is never queued.
  const result = await runConversationTurn({
    content: [{ type: "text", text: promptText }],
    conversationType: "background",
    signal: request.signal,
  });

  const parsed = parseReengagement(joinAssistantText(result.content));
  if (!parsed) {
    return jsonError(
      "Re-engagement turn did not produce a usable subject and body.",
      502,
    );
  }

  return Response.json({
    subject: parsed.subject,
    body: parsed.body,
    conversationId: result.conversationId,
  });
};
