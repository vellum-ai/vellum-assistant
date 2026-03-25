/**
 * HTTP route handlers for dictation processing.
 */

import {
  type ProfileResolution,
  resolveProfile,
} from "../../daemon/dictation-profile-store.js";
import {
  applyDictionary,
  expandSnippets,
} from "../../daemon/dictation-text-processing.js";
import { detectDictationModeHeuristic } from "../../daemon/handlers/dictation.js";
import type { DictationRequest } from "../../daemon/message-types/diagnostics.js";
import type { DictationContext } from "../../daemon/message-types/shared.js";
import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("diagnostics-routes");

// ---------------------------------------------------------------------------
// Dictation
// ---------------------------------------------------------------------------

type DictationMode = "dictation" | "command" | "action";

const DICTATION_CLASSIFICATION_TIMEOUT_MS = 5000;
const MAX_WINDOW_TITLE_LENGTH = 100;

function sanitizeWindowTitle(title: string | undefined): string {
  if (!title) return "";
  return title.replace(/[<>]/g, "").slice(0, MAX_WINDOW_TITLE_LENGTH);
}

interface DictationBody {
  transcription: string;
  context: DictationContext;
  profileId?: string;
}

function buildAppMetadataBlock(context: DictationContext): string {
  const windowTitle = sanitizeWindowTitle(context.windowTitle);
  return [
    "<app_metadata>",
    `App: ${context.appName} (${context.bundleIdentifier})`,
    `Window: ${windowTitle}`,
    "</app_metadata>",
  ].join("\n");
}

function buildCombinedDictationPrompt(
  body: DictationBody,
  stylePrompt?: string,
): string {
  const sections = [
    "You are a voice input assistant. You will receive a speech transcription and must:",
    '1. Classify it as "dictation" (text to insert) or "action" (task for an assistant to execute)',
    "2. If dictation, clean up the text. If action, return the raw transcription.",
    "",
    "## Classification",
    'DICTATION examples: "Hey how are you doing", "I think we should move forward with the proposal", "Dear team comma please review the attached document"',
    'ACTION examples: "Message Aaron on Slack saying hey what\'s up", "Send an email to the team about the meeting", "Open Spotify and play my playlist", "Search for flights to Denver", "Create a new document in Google Docs"',
    "",
    "Key signals for ACTION: the user is addressing an assistant and asking it to DO something (send, message, open, search, create, schedule, etc.)",
    "Key signals for DICTATION: the user is composing text content that should be typed out as-is",
    `Cursor in text field: ${body.context.cursorInTextField ? "yes" : "no"} -- if yes, lean toward dictation unless the intent to command is clear.`,
    "",
    "## Cleanup Rules (for dictation mode only)",
    "- Fix grammar, punctuation, and capitalization",
    "- Remove filler words (um, uh, like, you know)",
    '- Rewrite vague or hedging language ("so yeah probably", "I guess maybe") into clear, confident statements',
    "- Maintain the speaker's intent and meaning",
  ];

  if (stylePrompt) {
    sections.push(
      "",
      "## User Style (HIGHEST PRIORITY)",
      "The user has configured these style preferences. They OVERRIDE the default tone adaptation below.",
      "Follow these instructions precisely -- they reflect the user's personal writing voice and preferences.",
      "",
      stylePrompt,
    );
  }

  sections.push("", "## Tone Adaptation");

  if (stylePrompt) {
    sections.push(
      "Use these as fallback guidance only when the User Style above does not cover a specific aspect:",
    );
  } else {
    sections.push("Adapt your output tone based on the active application:");
  }

  sections.push(
    "- Email apps (Gmail, Mail): Professional but warm. Use proper greetings and sign-offs if appropriate.",
    "- Slack: Casual and conversational. Match typical chat style.",
    "- Code editors (VS Code, Xcode): Technical and concise. Code comments style.",
    "- Terminal: Command-like, terse.",
    "- Messages/iMessage: Very casual, texting style. Short sentences.",
    "- Notes/Docs: Neutral, clear writing.",
    "- Default: Match the user's natural voice.",
    "",
    "## Context Clues",
    "- Window title may contain recipient name (Slack DMs, email compose)",
    "- If you can identify a recipient, adapt formality to the apparent relationship",
    "- Maintain the user's natural voice -- don't over-formalize casual speech",
    "- The user's writing patterns and preferences may be available from memory context -- follow those when present",
    "",
    buildAppMetadataBlock(body.context),
  );

  return sections.join("\n");
}

function buildCommandPrompt(body: DictationBody, stylePrompt?: string): string {
  const sections = [
    "You are a text transformation assistant. The user has selected text and given a voice command to transform it.",
    "",
    "## Rules",
    "- Apply the instruction to the selected text",
    "- Return ONLY the transformed text, nothing else",
    "- Do NOT add explanations or commentary",
  ];

  if (stylePrompt) {
    sections.push(
      "",
      "## User Style (HIGHEST PRIORITY)",
      "The user has configured these style preferences. They OVERRIDE the default tone adaptation below.",
      "Follow these instructions precisely -- they reflect the user's personal writing voice and preferences.",
      "",
      stylePrompt,
    );
  }

  sections.push("", "## Tone Adaptation");

  if (stylePrompt) {
    sections.push(
      "Use these as fallback guidance only when the User Style above does not cover a specific aspect:",
    );
  } else {
    sections.push("Match the tone to the active application context:");
  }

  sections.push(
    "- Email apps (Gmail, Mail): Professional but warm.",
    "- Slack: Casual and conversational.",
    "- Code editors (VS Code, Xcode): Technical and concise.",
    "- Terminal: Command-like, terse.",
    "- Messages/iMessage: Very casual, texting style.",
    "- Notes/Docs: Neutral, clear writing.",
    "- Default: Match the user's natural voice.",
    "",
    "## Context Clues",
    "- Window title may contain recipient name (Slack DMs, email compose)",
    "- If you can identify a recipient, adapt formality to the apparent relationship",
    "- Maintain the user's natural voice -- don't over-formalize casual speech",
    "- The user's writing patterns and preferences may be available from memory context -- follow those when present",
    "",
    buildAppMetadataBlock(body.context),
    "",
    "Selected text:",
    body.context.selectedText ?? "",
    "",
    `Instruction: ${body.transcription}`,
  );

  return sections.join("\n");
}

function computeMaxTokens(inputLength: number): number {
  const estimatedInputTokens = Math.ceil(inputLength / 3);
  return Math.max(256, estimatedInputTokens + 128);
}

async function handleDictation(body: DictationBody): Promise<Response> {
  log.info(
    { transcriptionLength: body.transcription.length },
    "Dictation request received via HTTP",
  );

  const resolution = resolveProfile(
    body.context.bundleIdentifier,
    body.context.appName,
    body.profileId,
  );
  const { profile, source: profileSource } = resolution;
  log.info(
    { profileId: profile.id, profileSource },
    "Resolved dictation profile",
  );

  const profileMeta = {
    resolvedProfileId: profile.id,
    profileSource,
  };

  const stylePrompt = profile.stylePrompt || undefined;

  // Command mode: selected text present
  if (
    body.context.selectedText &&
    body.context.selectedText.trim().length > 0
  ) {
    log.info({ mode: "command" }, "Command mode (selected text present)");
    return handleCommandMode(body, profile, profileMeta, stylePrompt);
  }

  // Non-command: single LLM call that classifies AND cleans in one shot
  const transcription = expandSnippets(body.transcription, profile.snippets);

  try {
    const provider = await getConfiguredProvider();
    if (!provider) {
      log.warn(
        "Dictation: no provider available, using heuristic + raw transcription",
      );
      // Build a compatible msg for the heuristic
      const mode = detectDictationModeHeuristic({
        type: "dictation_request",
        transcription: body.transcription,
        context: body.context,
      } as DictationRequest);
      const normalizedText = applyDictionary(transcription, profile.dictionary);
      if (mode === "action") {
        return Response.json({
          text: body.transcription,
          mode: "action",
          actionPlan: `User wants to: ${body.transcription}`,
          ...profileMeta,
        });
      }
      return Response.json({
        text: normalizedText,
        mode,
        ...profileMeta,
      });
    }

    const systemPrompt = buildCombinedDictationPrompt(body, stylePrompt);
    const maxTokens = computeMaxTokens(transcription.length);
    const { signal, cleanup } = createTimeout(
      DICTATION_CLASSIFICATION_TIMEOUT_MS,
    );

    try {
      const response = await provider.sendMessage(
        [userMessage(`Transcription: "${transcription}"`)],
        [
          {
            name: "process_dictation",
            description: "Classify the voice input and return cleaned text",
            input_schema: {
              type: "object" as const,
              properties: {
                mode: {
                  type: "string",
                  enum: ["dictation", "action"],
                  description:
                    "dictation = user wants text inserted/cleaned up for typing. action = user wants the assistant to perform a task.",
                },
                text: {
                  type: "string",
                  description:
                    "If dictation: the cleaned/formatted text ready for insertion. If action: the raw transcription unchanged.",
                },
                reasoning: {
                  type: "string",
                  description: "Brief reasoning for the classification",
                },
              },
              required: ["mode", "text", "reasoning"],
            },
          },
        ],
        systemPrompt,
        {
          config: {
            modelIntent: "latency-optimized",
            max_tokens: maxTokens,
            tool_choice: {
              type: "tool" as const,
              name: "process_dictation",
            },
          },
          signal,
        },
      );
      cleanup();

      const toolBlock = extractToolUse(response);
      if (toolBlock) {
        const input = toolBlock.input as {
          mode?: string;
          text?: string;
          reasoning?: string;
        };
        const mode: DictationMode =
          input.mode === "action" ? "action" : "dictation";
        log.info(
          { mode, reasoning: input.reasoning },
          "LLM dictation classify+clean",
        );

        if (mode === "action") {
          return Response.json({
            text: body.transcription,
            mode: "action",
            actionPlan: `User wants to: ${body.transcription}`,
            ...profileMeta,
          });
        }
        const cleanedText = input.text?.trim() || transcription;
        const normalizedText = applyDictionary(cleanedText, profile.dictionary);
        return Response.json({
          text: normalizedText,
          mode: "dictation",
          ...profileMeta,
        });
      }

      log.warn("No tool_use block in combined dictation call, using heuristic");
    } finally {
      cleanup();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: message },
      "Combined dictation LLM call failed, using heuristic",
    );
  }

  // Heuristic fallback
  const fallbackMode = detectDictationModeHeuristic({
    type: "dictation_request",
    transcription: body.transcription,
    context: body.context,
  } as DictationRequest);
  log.info({ mode: fallbackMode }, "Using heuristic fallback");
  if (fallbackMode === "action") {
    return Response.json({
      text: body.transcription,
      mode: "action",
      actionPlan: `User wants to: ${body.transcription}`,
      ...profileMeta,
    });
  }
  const normalizedText = applyDictionary(transcription, profile.dictionary);
  return Response.json({
    text: normalizedText,
    mode: fallbackMode,
    ...profileMeta,
  });
}

async function handleCommandMode(
  body: DictationBody,
  profile: ReturnType<typeof resolveProfile>["profile"],
  profileMeta: {
    resolvedProfileId: string;
    profileSource: ProfileResolution["source"];
  },
  stylePrompt: string | undefined,
): Promise<Response> {
  const systemPrompt = buildCommandPrompt(body, stylePrompt);
  const inputLength =
    (body.context.selectedText ?? "").length + body.transcription.length;
  const maxTokens = Math.max(1024, computeMaxTokens(inputLength));

  try {
    const provider = await getConfiguredProvider();
    if (!provider) {
      log.warn("Command mode: no provider available, returning selected text");
      const normalizedText = applyDictionary(
        body.context.selectedText ?? body.transcription,
        profile.dictionary,
      );
      return Response.json({
        text: normalizedText,
        mode: "command",
        ...profileMeta,
      });
    }

    const response = await provider.sendMessage(
      [userMessage(body.transcription)],
      [],
      systemPrompt,
      { config: { modelIntent: "latency-optimized", max_tokens: maxTokens } },
    );

    const textBlock = response.content.find((b) => b.type === "text");
    const cleanedText =
      textBlock && "text" in textBlock
        ? textBlock.text.trim()
        : (body.context.selectedText ?? body.transcription);
    const normalizedText = applyDictionary(cleanedText, profile.dictionary);
    return Response.json({
      text: normalizedText,
      mode: "command",
      ...profileMeta,
    });
  } catch (err) {
    log.error({ err }, "Command mode LLM call failed, returning selected text");
    const normalizedText = applyDictionary(
      body.context.selectedText ?? body.transcription,
      profile.dictionary,
    );
    return Response.json({
      text: normalizedText,
      mode: "command",
      ...profileMeta,
    });
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function diagnosticsRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "dictation",
      method: "POST",
      policyKey: "dictation",
      summary: "Process dictation",
      description:
        "Classify voice input as dictation or action, clean up text, and apply user style preferences.",
      tags: ["diagnostics"],
      requestBody: {
        type: "object",
        properties: {
          transcription: {
            type: "string",
            description: "Raw speech transcription",
          },
          context: {
            type: "object",
            description:
              "Dictation context (app name, window title, bundle ID, cursor state, selected text)",
          },
          profileId: {
            type: "string",
            description: "Optional dictation profile ID",
          },
        },
        required: ["transcription", "context"],
      },
      responseBody: {
        type: "object",
        properties: {
          text: { type: "string", description: "Processed text output" },
          mode: {
            type: "string",
            description: "Detected mode: dictation, command, or action",
          },
          actionPlan: {
            type: "string",
            description: "Action plan (only when mode is action)",
          },
          resolvedProfileId: {
            type: "string",
            description: "Resolved dictation profile ID",
          },
          profileSource: {
            type: "string",
            description: "How the profile was resolved",
          },
        },
      },
      handler: async ({ req }) => {
        const body = (await req.json()) as DictationBody;
        if (!body.transcription) {
          return httpError("BAD_REQUEST", "transcription is required", 400);
        }
        if (!body.context) {
          return httpError("BAD_REQUEST", "context is required", 400);
        }
        return handleDictation(body);
      },
    },
  ];
}
