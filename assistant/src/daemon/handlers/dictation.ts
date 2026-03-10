import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import {
  type ProfileResolution,
  resolveProfile,
} from "../dictation-profile-store.js";
import {
  applyDictionary,
  expandSnippets,
} from "../dictation-text-processing.js";
import type { DictationRequest } from "../message-protocol.js";
import { defineHandlers, type HandlerContext, log } from "./shared.js";

// Action verbs for fast heuristic fallback (used when LLM classifier is unavailable)
const ACTION_VERBS = [
  "slack",
  "email",
  "send",
  "create",
  "open",
  "search",
  "find",
  "message",
  "text",
  "schedule",
  "remind",
  "launch",
  "navigate",
];

const DICTATION_CLASSIFICATION_TIMEOUT_MS = 5000;

const MAX_WINDOW_TITLE_LENGTH = 100;

/** Sanitize window title to mitigate prompt injection from attacker-controlled titles (e.g. browser tabs, Slack conversations). */
function sanitizeWindowTitle(title: string | undefined): string {
  if (!title) return "";
  return title
    .replace(/[<>]/g, "") // strip angle brackets to prevent tag injection
    .slice(0, MAX_WINDOW_TITLE_LENGTH);
}

/** Build a delimited app metadata block so the LLM treats it as contextual data, not instructions. */
function buildAppMetadataBlock(msg: DictationRequest): string {
  const windowTitle = sanitizeWindowTitle(msg.context.windowTitle);
  return [
    "<app_metadata>",
    `App: ${msg.context.appName} (${msg.context.bundleIdentifier})`,
    `Window: ${windowTitle}`,
    "</app_metadata>",
  ].join("\n");
}

type DictationMode = "dictation" | "command" | "action";

/** Fast heuristic fallback — used when LLM classifier is unavailable or fails. */
export function detectDictationModeHeuristic(
  msg: DictationRequest,
): DictationMode {
  // Command mode: selected text present — treat transcription as a transformation instruction
  if (msg.context.selectedText && msg.context.selectedText.trim().length > 0) {
    return "command";
  }

  // Action mode: transcription starts with an action verb
  const firstWord =
    msg.transcription.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (ACTION_VERBS.includes(firstWord)) {
    return "action";
  }

  // Dictation mode: cursor is in a text field with no selection — clean up for typing
  if (msg.context.cursorInTextField) {
    return "dictation";
  }

  return "dictation";
}

/** Build a combined system prompt that classifies AND cleans dictation in a single LLM call. */
function buildCombinedDictationPrompt(
  msg: DictationRequest,
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
    `Cursor in text field: ${msg.context.cursorInTextField ? "yes" : "no"} — if yes, lean toward dictation unless the intent to command is clear.`,
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
      "Follow these instructions precisely — they reflect the user's personal writing voice and preferences.",
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
    "- Maintain the user's natural voice — don't over-formalize casual speech",
    "- The user's writing patterns and preferences may be available from memory context — follow those when present",
    "",
    buildAppMetadataBlock(msg),
  );

  return sections.join("\n");
}

function buildCommandPrompt(
  msg: DictationRequest,
  stylePrompt?: string,
): string {
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
      "Follow these instructions precisely — they reflect the user's personal writing voice and preferences.",
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
    "- Maintain the user's natural voice — don't over-formalize casual speech",
    "- The user's writing patterns and preferences may be available from memory context — follow those when present",
    "",
    buildAppMetadataBlock(msg),
    "",
    "Selected text:",
    msg.context.selectedText ?? "",
    "",
    `Instruction: ${msg.transcription}`,
  );

  return sections.join("\n");
}

/** Compute dynamic max_tokens based on input length to avoid waste and truncation. */
function computeMaxTokens(inputLength: number): number {
  const estimatedInputTokens = Math.ceil(inputLength / 3);
  return Math.max(256, estimatedInputTokens + 128);
}

export async function handleDictationRequest(
  msg: DictationRequest,
  ctx: HandlerContext,
): Promise<void> {
  log.info(
    { transcriptionLength: msg.transcription.length },
    "Dictation request received",
  );

  // Resolve profile for all modes (metadata is included in response)
  const resolution = resolveProfile(
    msg.context.bundleIdentifier,
    msg.context.appName,
    msg.profileId,
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

  // Command mode: selected text present — deterministic, no classification needed
  if (msg.context.selectedText && msg.context.selectedText.trim().length > 0) {
    log.info({ mode: "command" }, "Command mode (selected text present)");
    await handleCommandMode(msg, ctx, profile, profileMeta, stylePrompt);
    return;
  }

  // Non-command: single LLM call that classifies AND cleans in one shot
  const transcription = expandSnippets(msg.transcription, profile.snippets);

  try {
    const provider = getConfiguredProvider();
    if (!provider) {
      log.warn(
        "Dictation: no provider available, using heuristic + raw transcription",
      );
      const mode = detectDictationModeHeuristic(msg);
      const normalizedText = applyDictionary(transcription, profile.dictionary);
      if (mode === "action") {
        ctx.send({
          type: "dictation_response",
          text: msg.transcription,
          mode: "action",
          actionPlan: `User wants to: ${msg.transcription}`,
          ...profileMeta,
        });
      } else {
        ctx.send({
          type: "dictation_response",
          text: normalizedText,
          mode,
          ...profileMeta,
        });
      }
      return;
    }

    const systemPrompt = buildCombinedDictationPrompt(msg, stylePrompt);
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
                    "dictation = user wants text inserted/cleaned up for typing. action = user wants the assistant to perform a task (send a message, open an app, search, navigate, control something).",
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
            tool_choice: { type: "tool" as const, name: "process_dictation" },
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
          ctx.send({
            type: "dictation_response",
            text: msg.transcription,
            mode: "action",
            actionPlan: `User wants to: ${msg.transcription}`,
            ...profileMeta,
          });
        } else {
          const cleanedText = input.text?.trim() || transcription;
          const normalizedText = applyDictionary(
            cleanedText,
            profile.dictionary,
          );
          ctx.send({
            type: "dictation_response",
            text: normalizedText,
            mode: "dictation",
            ...profileMeta,
          });
        }
        return;
      }

      // No tool_use block — fall through to heuristic
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
  const fallbackMode = detectDictationModeHeuristic(msg);
  log.info({ mode: fallbackMode }, "Using heuristic fallback");
  if (fallbackMode === "action") {
    ctx.send({
      type: "dictation_response",
      text: msg.transcription,
      mode: "action",
      actionPlan: `User wants to: ${msg.transcription}`,
      ...profileMeta,
    });
  } else {
    const normalizedText = applyDictionary(transcription, profile.dictionary);
    ctx.send({
      type: "dictation_response",
      text: normalizedText,
      mode: fallbackMode,
      ...profileMeta,
    });
  }
}

/** Handle command mode (selected text) — separate code path, latency-optimized. */
async function handleCommandMode(
  msg: DictationRequest,
  ctx: HandlerContext,
  profile: ReturnType<typeof resolveProfile>["profile"],
  profileMeta: {
    resolvedProfileId: string;
    profileSource: ProfileResolution["source"];
  },
  stylePrompt: string | undefined,
): Promise<void> {
  const systemPrompt = buildCommandPrompt(msg, stylePrompt);
  const inputLength =
    (msg.context.selectedText ?? "").length + msg.transcription.length;
  const maxTokens = Math.max(1024, computeMaxTokens(inputLength));

  try {
    const provider = getConfiguredProvider();
    if (!provider) {
      log.warn("Command mode: no provider available, returning selected text");
      const normalizedText = applyDictionary(
        msg.context.selectedText ?? msg.transcription,
        profile.dictionary,
      );
      ctx.send({
        type: "dictation_response",
        text: normalizedText,
        mode: "command",
        ...profileMeta,
      });
      return;
    }

    const response = await provider.sendMessage(
      [userMessage(msg.transcription)],
      [], // no tools
      systemPrompt,
      { config: { modelIntent: "latency-optimized", max_tokens: maxTokens } },
    );

    const textBlock = response.content.find((b) => b.type === "text");
    const cleanedText =
      textBlock && "text" in textBlock
        ? textBlock.text.trim()
        : (msg.context.selectedText ?? msg.transcription);
    const normalizedText = applyDictionary(cleanedText, profile.dictionary);
    ctx.send({
      type: "dictation_response",
      text: normalizedText,
      mode: "command",
      ...profileMeta,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Command mode LLM call failed, returning selected text");
    const normalizedText = applyDictionary(
      msg.context.selectedText ?? msg.transcription,
      profile.dictionary,
    );
    ctx.send({
      type: "dictation_response",
      text: normalizedText,
      mode: "command",
      ...profileMeta,
    });
    ctx.send({
      type: "error",
      message: `Dictation cleanup failed: ${message}`,
    });
  }
}

export const dictationHandlers = defineHandlers({
  dictation_request: handleDictationRequest,
});
