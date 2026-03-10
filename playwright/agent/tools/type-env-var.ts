/**
 * Type the value of an environment variable into an input field.
 *
 * This tool resolves an environment variable at runtime and types its value
 * without ever exposing the secret value in the tool result or conversation
 * context. Supports clicking an element by ID to focus it before typing.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import { runAXHelper } from "./ax-helper";
import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "type_env_var",
  description:
    "Type the value of an environment variable into an input field. The secret value is never returned in the tool result. Optionally accepts an element_id to click-to-focus before typing.",
  input_schema: {
    type: "object" as const,
    properties: {
      env_var: {
        type: "string",
        description:
          "The name of the environment variable to type (e.g., ANTHROPIC_API_KEY)",
      },
      element_id: {
        type: "integer",
        description:
          "Optional element ID (from query_elements) to click before typing. If provided, the element is clicked to focus it first.",
      },
    },
    required: ["env_var"],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolHandlerResult> {
  const envVar = input.env_var as string;
  const elementId = input.element_id as number | undefined;

  if (!process.env[envVar]) {
    return {
      result: {
        success: false,
        data: `Environment variable ${envVar} is not set`,
      },
    };
  }

  const args: string[] = ["--env-var", envVar];
  if (elementId !== undefined) {
    args.push("--id", String(elementId));
  }

  const result = runAXHelper("type-env", args, context);
  return {
    result: { success: result.success, data: result.data },
  };
}
