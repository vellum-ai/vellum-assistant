/**
 * `image_ask` — ask a vision-capable profile one question about one image in
 * the conversation.
 *
 * The plugin's sweep replaces every image with a short `[Image "<filename>"
 * auto-described …]` caption when the turn's model is text-only. The caption
 * carries the gist, not the detail: exact text, a number in a corner, how many
 * rows a table has. This tool re-opens the image for a specific question,
 * routing it to a vision profile and returning the answer as text.
 *
 * It is off the wire whenever the turn's model can see images itself, via the
 * `isActive` predicate, so a vision model never pays for its schema. The
 * `post-model-call` recovery path (a model the catalog calls vision-capable
 * that its endpoint rejects) runs without the tool on that call, since the
 * tool list for the call is already built; the next turn gates correctly.
 *
 * Everything here works against the failure mode that matters: a text-only
 * model stating a detail it never saw. The vision prompt confines the answer
 * to what is visible and has it lead with a marker when the image does not
 * show it; the result relays that as an explicit "not in image" instead of a
 * value; and the answer is always framed as one model's reading of the image
 * rather than as fact.
 *
 * Nothing here throws: every failure comes back as an `isError` result the
 * model can read and act on.
 */

import { readFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";

import {
  doesSupportVision,
  getWorkspaceDir,
  RiskLevel,
  type ToolActivationContext,
  type ToolContext,
  type ToolDefinition,
  type ToolExecutionResult,
} from "@vellumai/plugin-api";

import {
  listConversationImages,
  resolveConversationImage,
} from "../src/image-index.js";
import { describeImage, findVisionProfile } from "../src/vision-caption.js";

/** Response cap for one answer: room for quoted text, not for an essay. */
const ANSWER_MAX_TOKENS = 1024;

/**
 * Marker the vision model is told to lead with when the image does not
 * contain the answer.
 *
 * A declared protocol, not a guess: the answer is scanned for this exact
 * prefix and nothing else, so the caller learns the answer is unsupported
 * without any heuristic reading of the prose. A model that ignores the
 * instruction just yields an ordinary answer, which is the behavior without
 * the marker at all.
 */
const NOT_VISIBLE_MARKER = "NOT_VISIBLE:";

const ASK_SYSTEM_PROMPT =
  "You are a vision assistant answering one question about one image for a " +
  "text-only assistant that cannot see it. Answer only from what is visible " +
  "in the image. Quote text and numbers exactly as they are printed, " +
  "including case, punctuation, spacing, and units, and never round, " +
  "reformat, complete, or correct them. Do not infer the answer from context, " +
  "from what the image is probably of, or from anything you know outside it. " +
  `If the answer is not visible in the image, or the image is too small, ` +
  `blurred, or cropped to read it, begin your reply with ${NOT_VISIBLE_MARKER} ` +
  "and then say what you can see instead. Never guess a value in order to " +
  "have something to answer with.";

/**
 * The answer text plus whether the vision model reported the image does not
 * show it.
 */
function readAnswer(raw: string): { answer: string; notVisible: boolean } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(NOT_VISIBLE_MARKER)) {
    return { answer: trimmed, notVisible: false };
  }
  return {
    answer: trimmed.slice(NOT_VISIBLE_MARKER.length).trim(),
    notVisible: true,
  };
}

function errorResult(content: string): ToolExecutionResult {
  return { content, isError: true };
}

/** Filenames the model can name, newest first, for an unresolved reference. */
function knownFilenames(filePaths: string[]): string {
  return filePaths.map((path) => `"${basename(path)}"`).join(", ");
}

/** Whether `filePath` resolves inside the workspace root. */
function isInsideWorkspace(filePath: string): boolean {
  try {
    const root = resolve(getWorkspaceDir());
    const target = resolve(filePath);
    return target === root || target.startsWith(`${root}${sep}`);
  } catch {
    return false;
  }
}

const imageAsk = {
  description:
    "Ask a vision model one question about an image in this conversation. " +
    "You cannot see images: each one reaches you as an " +
    '`[Image "<filename>" auto-described …]` summary, which covers the gist ' +
    "and omits detail. Use this tool for the detail: exact text or numbers as " +
    "printed, counts, colors, layout, or anything the summary left out. Name " +
    'the image with `image` (the filename from the summary, e.g. "chart.png", ' +
    "or its stored path); omit `image` to use the most recent one. The model " +
    "answering sees only the image and your question: it has no conversation " +
    "history, no memory of earlier turns, no access to files, and no tools. " +
    "Make each question self-contained and specific, naming what to look for " +
    "rather than referring to anything said earlier. Ask one question per " +
    "call, and call it again for the next detail rather than asking for " +
    "several at once. Ask whenever a detail matters instead of working from " +
    "what the summary implies. The answer is one model's reading of the " +
    "image, so pass on what it says and do not add detail it did not give; " +
    "when it reports the answer is not in the image, say that rather than " +
    "supplying a plausible value. The answer comes back as text, never as an " +
    "image.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "The self-contained question to answer about the image, e.g. " +
          '"What is the exact total shown in the bottom-right cell?".',
      },
      image: {
        type: "string",
        description:
          "Filename of the image to look at, as it appears in the " +
          '`[Image "<filename>" …]` summary, or its full stored path. Omit ' +
          "to use the most recent image in the conversation.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  defaultRiskLevel: RiskLevel.Low,
  /**
   * Reading one image costs a vision call, so the tool is offered only to a
   * model that cannot look at the image itself.
   */
  isActive: ({ model }: ToolActivationContext) => !doesSupportVision(model),
  execute: async (
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> => {
    try {
      const question = typeof input.question === "string" ? input.question : "";
      if (question.trim() === "") {
        return errorResult("image_ask requires a non-empty `question`.");
      }
      const requested = typeof input.image === "string" ? input.image : "";

      const images = listConversationImages(ctx.conversationId);
      if (images.length === 0) {
        return errorResult(
          "No images are available in this conversation to ask about.",
        );
      }

      const match = resolveConversationImage(images, requested);
      if (match == null) {
        return errorResult(
          `No image named "${requested}" in this conversation. Available images: ${knownFilenames(
            images.map((image) => image.filePath),
          )}.`,
        );
      }

      if (!isInsideWorkspace(match.filePath)) {
        return errorResult(
          `The image "${basename(
            match.filePath,
          )}" is stored outside the workspace and cannot be read.`,
        );
      }

      let data: string;
      try {
        data = readFileSync(match.filePath).toString("base64");
      } catch {
        return errorResult(
          `The image "${basename(
            match.filePath,
          )}" is no longer readable on disk.`,
        );
      }

      const profileKey = findVisionProfile();
      if (profileKey == null) {
        return errorResult(
          "No vision-capable model is configured, so images cannot be examined. Ask the user to configure one.",
        );
      }

      const answer = await describeImage(
        {
          type: "image",
          source: { type: "base64", media_type: match.mediaType, data },
        },
        ctx.conversationId,
        profileKey,
        {
          systemPrompt: ASK_SYSTEM_PROMPT,
          userPrompt: question,
          maxTokens: ANSWER_MAX_TOKENS,
          signal: ctx.signal,
        },
      );
      if (answer == null) {
        return errorResult(
          `Could not get an answer about "${basename(
            match.filePath,
          )}" from the vision model. Retry if the detail matters.`,
        );
      }

      const name = basename(match.filePath);
      const read = readAnswer(answer);
      if (read.notVisible) {
        return {
          content:
            `The image "${name}" does not show the answer to that question. ` +
            `What the vision model could see: ${read.answer}\n\n` +
            "Do not state the detail you asked for as fact. Ask about " +
            "something the image does show, or tell the user it is not in " +
            "the image.",
          isError: false,
          status: "not in image",
        };
      }

      return {
        content:
          `Answer about "${name}", read from the image by a vision model: ` +
          `${read.answer}`,
        isError: false,
      };
    } catch (err) {
      return errorResult(
        `image_ask failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
} satisfies ToolDefinition;

export default imageAsk;
