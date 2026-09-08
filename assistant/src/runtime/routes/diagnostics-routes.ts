/**
 * Route handlers for dictation processing.
 */

import { z } from "zod";

import { DictationRequestSchema } from "../../api/requests/dictation.js";
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
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("diagnostics-routes");

// ---------------------------------------------------------------------------
// Dictation
// ---------------------------------------------------------------------------

/**
 * `command` is a selection changed by the words, `question` a selection the
 * words asked about. Both need selected text; which one comes back is the
 * model's reading of the words, so a client that holds a key over a passage
 * and says "what does this mean" is not handed a rewrite of it.
 */
type DictationMode = "dictation" | "command" | "action" | "question";

const DICTATION_CLASSIFICATION_TIMEOUT_MS = 5000;
const MAX_WINDOW_TITLE_LENGTH = 100;

function sanitizeWindowTitle(title: string | undefined): string {
  if (!title) {
    return "";
  }
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
  // Every line here is read on every hold, so the prompt says each thing
  // once and leaves the model no reasoning to write.
  const sections = [
    "You are a voice input assistant. Given a speech transcription, classify it and, if it is dictation, clean it up.",
    "",
    "## Classification",
    "dictation: the user is composing text to be typed as-is.",
    "action: the user is asking an assistant to do something (send, message, open, search, create, schedule). Return the transcription unchanged.",
    `Cursor in text field: ${body.context.cursorInTextField ? "yes" : "no"}. If yes, lean toward dictation unless the intent to command is clear.`,
    "",
    "## Cleanup",
    "- Fix grammar, punctuation and capitalization; remove filler words",
    "- Rewrite hedging into clear statements, keeping the speaker's meaning",
    "- When the speaker enumerates items, lay them out as a list, one per line",
    "- Keep the user's natural voice; do not over-formalize casual speech",
  ];

  if (stylePrompt) {
    sections.push(
      "",
      "## User Style (highest priority)",
      "The user's own writing preferences. They override the tone guidance below.",
      "",
      stylePrompt,
    );
  }

  sections.push(
    "",
    "## Tone",
    stylePrompt
      ? "Fallback guidance where the User Style above is silent:"
      : "Adapt tone to the active application:",
    "- Email: professional but warm, greetings and sign-offs where they fit",
    "- Slack: casual and conversational",
    "- Code editors: technical and concise",
    "- Terminal: terse, command-like",
    "- Messages: very casual, short sentences",
    "- Notes and docs: neutral, clear writing",
    "- Otherwise: the user's natural voice",
    "The window title may name the recipient; adapt formality to the apparent relationship.",
    "",
    buildAppMetadataBlock(body.context),
  );

  return sections.join("\n");
}

function buildCommandPrompt(body: DictationBody, stylePrompt?: string): string {
  const sections = [
    "You are a text transformation assistant. The user has selected text and spoken. The words are either an instruction to change the selected text or a question about it.",
    "",
    "## Rules",
    "- If the words ask for a changed version of the selected text (rewrite, shorten, translate, fix, make it lighter, turn it into a list), kind is edit and text is ONLY the transformed text, nothing else",
    "- If the words ask about the selected text rather than for a changed version of it (what does this mean, is this right, who said this, summarize it for me), kind is answer and text is empty",
    "- Do NOT add explanations or commentary to an edit",
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

interface DictationResult {
  text: string;
  mode: DictationMode;
  actionPlan?: string;
  resolvedProfileId: string;
  profileSource: ProfileResolution["source"];
}

async function handleDictation(body: DictationBody): Promise<DictationResult> {
  log.info(
    { transcriptionLength: body.transcription.length },
    "Dictation request received",
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

  // Covers provider resolution as well as the call, which is what the caller
  // waits for.
  const modelStartedAt = Date.now();
  try {
    const provider = await getConfiguredProvider("interactionClassifier");
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
        return {
          text: body.transcription,
          mode: "action",
          actionPlan: `User wants to: ${body.transcription}`,
          ...profileMeta,
        };
      }
      return {
        text: normalizedText,
        mode,
        ...profileMeta,
      };
    }

    const systemPrompt = buildCombinedDictationPrompt(body, stylePrompt);
    const maxTokens = computeMaxTokens(transcription.length);
    const { signal, cleanup } = createTimeout(
      DICTATION_CLASSIFICATION_TIMEOUT_MS,
    );

    try {
      const response = await provider.sendMessage(
        [userMessage(`Transcription: "${transcription}"`)],
        {
          tools: [
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
                },
                required: ["mode", "text"],
              },
            },
          ],
          systemPrompt,
          config: {
            callSite: "interactionClassifier",
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
        };
        const mode: DictationMode =
          input.mode === "action" ? "action" : "dictation";
        log.info(
          {
            mode,
            modelMs: Date.now() - modelStartedAt,
            inChars: transcription.length,
            outChars: input.text?.length ?? 0,
          },
          "LLM dictation classify+clean",
        );

        if (mode === "action") {
          return {
            text: body.transcription,
            mode: "action",
            actionPlan: `User wants to: ${body.transcription}`,
            ...profileMeta,
          };
        }
        const cleanedText = input.text?.trim() || transcription;
        const normalizedText = applyDictionary(cleanedText, profile.dictionary);
        return {
          text: normalizedText,
          mode: "dictation",
          ...profileMeta,
        };
      }

      log.warn(
        { modelMs: Date.now() - modelStartedAt },
        "No tool_use block in combined dictation call, using heuristic",
      );
    } finally {
      cleanup();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: message, modelMs: Date.now() - modelStartedAt },
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
    return {
      text: body.transcription,
      mode: "action",
      actionPlan: `User wants to: ${body.transcription}`,
      ...profileMeta,
    };
  }
  const normalizedText = applyDictionary(transcription, profile.dictionary);
  return {
    text: normalizedText,
    mode: fallbackMode,
    ...profileMeta,
  };
}

async function handleCommandMode(
  body: DictationBody,
  profile: ReturnType<typeof resolveProfile>["profile"],
  profileMeta: {
    resolvedProfileId: string;
    profileSource: ProfileResolution["source"];
  },
  stylePrompt: string | undefined,
): Promise<DictationResult> {
  const systemPrompt = buildCommandPrompt(body, stylePrompt);
  const inputLength =
    (body.context.selectedText ?? "").length + body.transcription.length;
  const maxTokens = Math.max(1024, computeMaxTokens(inputLength));

  try {
    const provider = await getConfiguredProvider("interactionClassifier");
    if (!provider) {
      log.warn("Command mode: no provider available, returning selected text");
      const normalizedText = applyDictionary(
        body.context.selectedText ?? body.transcription,
        profile.dictionary,
      );
      return {
        text: normalizedText,
        mode: "command",
        ...profileMeta,
      };
    }

    const modelStartedAt = Date.now();
    const response = await provider.sendMessage(
      [userMessage(body.transcription)],
      {
        tools: [
          {
            name: "transform_selection",
            description:
              "Return the selected text changed as instructed, or say the words were a question about it",
            input_schema: {
              type: "object" as const,
              properties: {
                kind: {
                  type: "string",
                  enum: ["edit", "answer"],
                  description:
                    "edit = the words ask for a changed version of the selected text. answer = the words ask about the selected text and no changed version is wanted.",
                },
                text: {
                  type: "string",
                  description:
                    "If edit: the transformed text only, ready to replace the selection. If answer: empty.",
                },
              },
              required: ["kind", "text"],
            },
          },
        ],
        systemPrompt,
        config: {
          callSite: "interactionClassifier",
          max_tokens: maxTokens,
          tool_choice: { type: "tool" as const, name: "transform_selection" },
        },
      },
    );

    const toolBlock = extractToolUse(response);
    const input = (toolBlock?.input ?? {}) as { kind?: string; text?: string };
    const edited = input.text?.trim() ?? "";
    const isQuestion =
      input.kind === "answer" || (toolBlock !== undefined && !edited);
    log.info(
      {
        mode: isQuestion ? "question" : "command",
        modelMs: Date.now() - modelStartedAt,
        inChars: inputLength,
        outChars: edited.length,
      },
      "LLM selection transform",
    );
    if (isQuestion) {
      return {
        text: body.transcription,
        mode: "question",
        ...profileMeta,
      };
    }
    // No tool block at all is a model that did not answer the question
    // asked; the selection goes back unchanged, which a client reads as
    // nothing to put in its place.
    const cleanedText =
      edited || (body.context.selectedText ?? body.transcription);
    const normalizedText = applyDictionary(cleanedText, profile.dictionary);
    return {
      text: normalizedText,
      mode: "command",
      ...profileMeta,
    };
  } catch (err) {
    log.error({ err }, "Command mode LLM call failed, returning selected text");
    const normalizedText = applyDictionary(
      body.context.selectedText ?? body.transcription,
      profile.dictionary,
    );
    return {
      text: normalizedText,
      mode: "command",
      ...profileMeta,
    };
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "dictation_post",
    endpoint: "dictation",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Process dictation",
    description:
      "Classify voice input as dictation or action, clean up text, and apply user style preferences.",
    tags: ["diagnostics"],
    requestBody: DictationRequestSchema,
    responseBody: z.object({
      text: z.string().describe("Processed text output"),
      mode: z
        .string()
        .describe(
          "Detected mode: dictation, command, action, or question (selected text the words asked about rather than changed; text is the transcription)",
        ),
      actionPlan: z
        .string()
        .optional()
        .describe("Action plan (only when mode is action)"),
      resolvedProfileId: z.string().describe("Resolved dictation profile ID"),
      profileSource: z.string().describe("How the profile was resolved"),
    }),
    handler: async ({ body = {} }: RouteHandlerArgs) => {
      const { transcription, context, profileId } =
        body as unknown as DictationBody;
      if (!transcription) {
        throw new BadRequestError("transcription is required");
      }
      if (!context) {
        throw new BadRequestError("context is required");
      }
      return handleDictation({ transcription, context, profileId });
    },
  },
];
