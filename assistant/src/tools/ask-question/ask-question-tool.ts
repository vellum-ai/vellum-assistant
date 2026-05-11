import { z } from "zod";

import { QuestionPrompter } from "../../permissions/question-prompter.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { broadcastMessage } from "../../runtime/assistant-event-hub.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

// ── Input schema ────────────────────────────────────────────────────
// Runtime validation lives in Zod; the wire-level definition surfaced
// to the LLM is the hand-written JSON Schema in getDefinition() below.
// (The codebase does not currently use zod-to-json-schema for tool defs,
// so the two are kept in sync manually.)

const OptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

const InputSchema = z.object({
  question: z.string().min(1),
  description: z.string().optional(),
  // 2–4 LLM-supplied options. The client renders a fixed 5th "Type
  // something else" slot for free-text, so the model must keep the
  // structured set to 4 or fewer.
  options: z.array(OptionSchema).min(2).max(4),
  freeTextPlaceholder: z.string().optional(),
});

export type AskQuestionInput = z.infer<typeof InputSchema>;

// ── Tool description ────────────────────────────────────────────────

const DESCRIPTION = [
  "Ask the user a clarifying question with a small set of structured options.",
  "Use when the request is ambiguous and a short multiple-choice prompt would",
  "resolve it faster than free-form back-and-forth.",
  "",
  "Provide 2–4 options. A free-text fallback is always added by the UI — do not",
  "include a 'something else' option yourself.",
  "",
  "Each option needs a stable `id` (the value the response carries back) and a",
  "short human-readable `label`. Optional `description` adds one line of",
  "context shown beneath the label.",
].join("\n");

// ── Tool ────────────────────────────────────────────────────────────

export class AskQuestionTool implements Tool {
  name = "ask_question";
  description = DESCRIPTION;
  category = "interaction";
  defaultRiskLevel = RiskLevel.Low;

  // Override hook for tests: lets a test replace the prompter factory
  // without monkey-patching the module. Default factory wires the real
  // broadcastMessage so the question reaches every connected client.
  private prompterFactory: () => Pick<QuestionPrompter, "prompt">;

  constructor(
    prompterFactory: () => Pick<QuestionPrompter, "prompt"> = () =>
      new QuestionPrompter({ broadcastMessage }),
  ) {
    this.prompterFactory = prompterFactory;
  }

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The clarifying question shown to the user.",
          },
          description: {
            type: "string",
            description:
              "Optional one-line context shown beneath the question.",
          },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            description:
              "2–4 structured options. The UI always appends a free-text fallback slot, so do not include a 'something else' option here.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "Stable identifier for this option (returned verbatim in the response).",
                },
                label: {
                  type: "string",
                  description: "Short human-readable label.",
                },
                description: {
                  type: "string",
                  description:
                    "Optional one-line context shown beneath the label.",
                },
              },
              required: ["id", "label"],
            },
          },
          freeTextPlaceholder: {
            type: "string",
            description:
              "Optional placeholder text shown inside the free-text fallback input.",
          },
        },
        required: ["question", "options"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        content: `Invalid input: ${parsed.error.message}`,
        isError: true,
      };
    }

    const { question, description, options, freeTextPlaceholder } = parsed.data;

    const prompter = this.prompterFactory();
    const result = await prompter.prompt({
      conversationId: context.conversationId,
      question,
      description,
      options,
      freeTextPlaceholder,
      toolUseId: context.toolUseId,
      signal: context.signal,
    });

    switch (result.decision) {
      case "option": {
        const chosen = options.find((o) => o.id === result.optionId);
        const label = chosen?.label ?? "(unknown)";
        return {
          content: `Option: ${result.optionId}\nLabel: ${label}`,
          isError: false,
        };
      }
      case "free_text": {
        return {
          content: `Free text: ${result.text ?? ""}`,
          isError: false,
        };
      }
      case "timed_out":
        return {
          content: "User did not respond within timeout",
          isError: true,
        };
      case "aborted":
        return {
          content: "Question aborted",
          isError: true,
        };
    }
  }
}

export const askQuestionTool = new AskQuestionTool();
