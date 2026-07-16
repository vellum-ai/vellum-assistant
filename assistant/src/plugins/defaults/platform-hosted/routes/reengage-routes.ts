/**
 * Route handler for the platform-hosted re-engagement endpoint.
 *
 * Serves one operation:
 *   - platform_hosted_reengage (POST platform-hosted/reengage): runs a
 *     background conversation turn asking the assistant to compose a
 *     re-engagement email in its own voice, then returns the parsed subject
 *     line and body so the platform can send it to the user.
 *
 * The assistant's full agent loop drives the turn (identity, memory, and
 * conversation history are all in scope), so the copy is personal and written
 * in the assistant's voice rather than a generic template. The turn runs in a
 * `background` conversation so it never surfaces in the user's sidebar.
 */

import { z } from "zod";

import { runConversationTurn } from "../../../../plugin-api/conversation-turn.js";
import type { ContentBlock, TextContent } from "../../../../providers/types.js";
import { ACTOR_PRINCIPALS } from "../../../../runtime/auth/route-policy.js";
import {
  InternalError,
  ServiceUnavailableError,
} from "../../../../runtime/routes/errors.js";
import type {
  RouteDefinition,
  RouteHandlerArgs,
} from "../../../../runtime/routes/types.js";

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
// Schemas
// ---------------------------------------------------------------------------

const ReengageRequestSchema = z.object({
  /**
   * Existing conversation to draw context from and run the turn in. When
   * omitted, a fresh background conversation is created for the turn.
   */
  conversationId: z.string().min(1).optional(),
  /**
   * Extra guidance appended to the base instruction — e.g. a campaign angle or
   * a specific thread the platform wants the email to reference.
   */
  additionalGuidance: z.string().optional(),
});

const ReengageResponseSchema = z.object({
  subject: z.string(),
  body: z.string(),
  conversationId: z.string(),
});
type ReengageResponse = z.infer<typeof ReengageResponseSchema>;

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

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleReengage(
  args: RouteHandlerArgs,
): Promise<ReengageResponse> {
  const { conversationId, additionalGuidance } = ReengageRequestSchema.parse(
    args.body ?? {},
  );

  const promptText = additionalGuidance
    ? `${REENGAGE_PROMPT}\n\nAdditional guidance for this email:\n${additionalGuidance}`
    : REENGAGE_PROMPT;

  const result = await runConversationTurn({
    ...(conversationId ? { conversationId } : {}),
    content: [{ type: "text", text: promptText }],
    conversationType: "background",
    ...(args.abortSignal ? { signal: args.abortSignal } : {}),
  });

  if (result.queued) {
    throw new ServiceUnavailableError(
      "The conversation is busy processing another turn. Retry the re-engagement request shortly.",
    );
  }

  const text = joinAssistantText(result.content);
  const parsed = parseReengagement(text);
  if (!parsed) {
    throw new InternalError(
      "Re-engagement turn did not produce a usable subject and body.",
    );
  }

  return {
    subject: parsed.subject,
    body: parsed.body,
    conversationId: result.conversationId,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "platform_hosted_reengage",
    endpoint: "platform-hosted/reengage",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Generate a re-engagement email in the assistant's voice",
    description:
      "Runs a background conversation turn asking the assistant to compose a short re-engagement email drawing on the user's context, then returns the parsed subject line and body for the platform to send.",
    tags: ["platform-hosted"],
    handler: handleReengage,
    requestBody: ReengageRequestSchema,
    responseBody: ReengageResponseSchema,
  },
];
