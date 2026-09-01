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

type DictationMode = "dictation" | "command" | "action";

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

export function computeMaxTokens(inputLength: number): number {
  const estimatedInputTokens = Math.ceil(inputLength / 3);
  // The cleanup tool call has to carry the whole transcript back in its `text`
  // argument, plus a `reasoning` string and the JSON scaffolding around both,
  // so the budget has to cover well more than the input. The old
  // `estimatedInputTokens + 128` left roughly 128 tokens for reasoning and
  // scaffolding combined, and a `max_tokens` stop cuts the tool JSON mid-`text`
  // -- which used to be accepted verbatim as the cleaned text (LUM-3432).
  // `max_tokens` is a ceiling rather than a target, so raising it costs no
  // latency on a call that stops well short of it.
  return Math.max(512, estimatedInputTokens * 2 + 256);
}

/**
 * Smallest transcript the length-ratio check below applies to. Short
 * utterances legitimately shrink a long way once fillers go ("um yeah okay
 * so" -> "Okay"), so the ratio is noise below this length.
 */
const CLEANUP_RATIO_MIN_LENGTH = 40;

/**
 * How much of the spoken transcript the cleanup pass is allowed to drop.
 * Cleanup removes fillers and tightens phrasing, so some shrink is expected;
 * losing more than this is a truncated tool call or a summary, not a cleanup.
 */
const CLEANUP_MIN_LENGTH_RATIO = 0.6;

export type CleanupRejection = "truncated" | "too-short";

/**
 * Decide whether the cleanup model's rewrite is safe to use as the payload.
 *
 * The rewrite replaces what the user actually said, so it only wins when it
 * is plausibly the same utterance. A `max_tokens` stop means the tool JSON
 * was cut mid-argument, and a rewrite that lost most of the transcript is a
 * summary; both used to be inserted verbatim, silently sending a fragment of
 * a request the user had spoken in full (LUM-3432). In either case the raw
 * transcript is the safer payload: unpolished beats wrong.
 */
export function resolveCleanedDictation(
  raw: string,
  cleaned: string,
  stopReason: string,
): { text: string; rejected: CleanupRejection | null } {
  const trimmed = cleaned.trim();
  if (!trimmed) {
    return { text: raw, rejected: null };
  }
  if (stopReason === "max_tokens") {
    return { text: raw, rejected: "truncated" };
  }
  if (
    raw.length >= CLEANUP_RATIO_MIN_LENGTH &&
    trimmed.length < raw.length * CLEANUP_MIN_LENGTH_RATIO
  ) {
    return { text: raw, rejected: "too-short" };
  }
  return { text: trimmed, rejected: null };
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
          reasoning?: string;
        };
        const mode: DictationMode =
          input.mode === "action" ? "action" : "dictation";
        log.info(
          { mode, reasoning: input.reasoning },
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
        const { text: cleanedText, rejected } = resolveCleanedDictation(
          transcription,
          input.text ?? "",
          response.stopReason,
        );
        if (rejected) {
          // Lengths only -- transcript content must never be logged.
          log.warn(
            {
              rejected,
              stopReason: response.stopReason,
              rawChars: transcription.length,
              cleanedChars: input.text?.trim().length ?? 0,
            },
            "Dictation cleanup rejected, using raw transcription",
          );
        }
        const normalizedText = applyDictionary(cleanedText, profile.dictionary);
        return {
          text: normalizedText,
          mode: "dictation",
          ...profileMeta,
        };
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

    const response = await provider.sendMessage(
      [userMessage(body.transcription)],
      {
        tools: [],
        systemPrompt,
        config: { callSite: "interactionClassifier", max_tokens: maxTokens },
      },
    );

    const textBlock = response.content.find((b) => b.type === "text");
    const cleanedText =
      textBlock && "text" in textBlock
        ? textBlock.text.trim()
        : (body.context.selectedText ?? body.transcription);
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
      mode: z.string().describe("Detected mode: dictation, command, or action"),
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
