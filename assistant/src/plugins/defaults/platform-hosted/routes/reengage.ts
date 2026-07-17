/**
 * Platform-hosted `/reengage` route.
 *
 * Authored in the userland plugin route format (`export const POST`, standard
 * Web `Request`/`Response`, imports from `@vellumai/plugin-api`) so it is
 * served as-is once the assistant dispatches default-plugin routes.
 *
 * The handler makes one structured LLM call: the assistant composes a short
 * re-engagement email in its own voice and returns it by calling the
 * `compose_reengagement_email` tool, so the subject and body come back as
 * typed fields rather than being parsed out of free text. The platform sends
 * the result to the user.
 */

import {
  getConfiguredProvider,
  type Message,
  type ToolUseContent,
} from "@vellumai/plugin-api";

// ---------------------------------------------------------------------------
// Prompt + tool
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the user's personal assistant, writing a re-engagement email to draw them back into your work together. Write in your own voice, addressed directly to the user. Draw on what you know about them and your recent conversations so the note is personal and specific — reference something concrete you have been working on, or a next step that is waiting on them, rather than a generic "just checking in." Keep it warm, brief, and low-pressure: a few sentences at most, with no pushy or salesy language.`;

const USER_PROMPT = `Compose the re-engagement email now and return it by calling the compose_reengagement_email tool.`;

/**
 * Structured-output tool. Forcing the model to call this returns the email as
 * typed `subject` / `body` fields instead of free text that has to be parsed.
 */
const COMPOSE_TOOL = {
  name: "compose_reengagement_email",
  description: "Return the re-engagement email to send to the user.",
  input_schema: {
    type: "object" as const,
    properties: {
      subject: {
        type: "string",
        description:
          "A short, specific subject line that would make the user want to open the email.",
      },
      body: {
        type: "string",
        description:
          "The plain-text email body, written as if speaking directly to the user.",
      },
    },
    required: ["subject", "body"],
  },
};

function jsonError(message: string, status: number): Response {
  return Response.json({ error: { message } }, { status });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const POST = async (request: Request): Promise<Response> => {
  const provider = await getConfiguredProvider("inference");
  if (!provider) {
    return jsonError("No LLM provider is configured.", 503);
  }

  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: USER_PROMPT }] },
  ];
  const response = await provider.sendMessage(messages, {
    tools: [COMPOSE_TOOL],
    systemPrompt: SYSTEM_PROMPT,
    config: {
      callSite: "inference",
      max_tokens: 1024,
      tool_choice: { type: "tool" as const, name: COMPOSE_TOOL.name },
    },
    signal: request.signal,
  });

  const toolUse = response.content.find(
    (block): block is ToolUseContent =>
      block.type === "tool_use" && block.name === COMPOSE_TOOL.name,
  );
  const input = toolUse?.input ?? {};
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!subject || !body) {
    return jsonError(
      "The model did not return a usable subject and body.",
      502,
    );
  }

  return Response.json({ subject, body });
};
