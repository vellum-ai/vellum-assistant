/**
 * Anthropic agent loop for executing Playwright test cases.
 *
 * Takes a markdown test case, sends it to Claude with available browser tools,
 * and runs the agent in a loop until a test result is reported.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import { TOOL_DEFINITIONS, executeTool, type TestResult } from "./tools";

// ── Constants ───────────────────────────────────────────────────────

const MAX_ITERATIONS = 1000;
const MODEL = "claude-opus-4-6";

const SYSTEM_PROMPT = `You are a QA test automation agent for a desktop application. Your job is to execute end-to-end test cases described in markdown and verify the expected outcomes.

The test cases are written from the perspective of a non-technical end user. You must translate each plain-language step into the appropriate tool calls. Do not expect CSS selectors, shell commands, or technical details in the test steps — figure out the right actions yourself.

Available tool categories:
- App lifecycle: launch_app — launches the desktop application.
- Desktop interaction: applescript, run_shell, wait — interact with the native macOS app via System Events (clicking buttons, typing text, reading accessibility trees, taking screenshots).
- Secrets: get_anthropic_api_key — retrieve the Anthropic API key from the environment when a test step requires entering an API key.
- Browser tools: goto, click, fill, check, get_text, get_page_content, get_current_url, screenshot — for web-based UI testing.
- Utility tools: http_request, report_result — for API calls and reporting test outcomes.

Rules:
- Execute each step described in the markdown test case in order.
- Use applescript with System Events to interact with native macOS UI elements (buttons, text fields, etc.). Use the accessibility tree to discover element names and hierarchy.
- When verifying UI state, take screenshots or inspect the accessibility tree as needed — the test steps won't tell you to do this explicitly.
- Some actions (like launching an app) may take time. Be patient and retry if an element is not yet available.
- Never embed secrets directly in test content. Use get_anthropic_api_key to retrieve the API key at runtime.
- After completing all steps, verify each expected outcome.
- You MUST call report_result exactly once when done, indicating whether the test passed or failed.
- If a step fails (tool returns an error), try to recover once. If it still fails, report the test as failed with details.`;

// ── Agent Loop ──────────────────────────────────────────────────────

export interface AgentOptions {
  testContent: string;
  page: Page;
  screenshotDir: string;
  verbose?: boolean;
}

export async function runAgent(options: AgentOptions): Promise<TestResult> {
  const { testContent, page, screenshotDir, verbose = false } = options;

  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Execute the following test case:\n\n${testContent}`,
    },
  ];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (verbose) {
      console.log(`  [agent] iteration ${iteration + 1}`);
    }

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    const response = await stream.finalMessage();

    // Collect assistant content blocks
    const assistantContent = response.content;

    if (verbose) {
      for (const block of assistantContent) {
        if (block.type === "text") {
          console.log(`  [agent] text: ${block.text}`);
        } else if (block.type === "tool_use") {
          console.log(`  [agent] tool_use: ${block.name}(${JSON.stringify(block.input)})`);
        }
      }
    }

    // Add assistant message to conversation
    messages.push({ role: "assistant", content: assistantContent });

    // If the model stopped without tool use, the test didn't report a result
    if (response.stop_reason !== "tool_use") {
      return {
        passed: false,
        message: "Agent stopped without reporting a test result (no report_result call).",
      };
    }

    // Process all tool calls
    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    let finalTestResult: TestResult | undefined;

    for (const block of assistantContent) {
      if (block.type !== "tool_use") continue;

      const { result, testResult } = await executeTool(
        page,
        block.name,
        block.input as Record<string, unknown>,
        screenshotDir,
      );

      if (verbose) {
        console.log(`  [agent] result: ${result.success ? "ok" : "FAIL"} - ${result.data}`);
      }

      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.data ?? "",
        is_error: !result.success,
      });

      if (testResult) {
        finalTestResult = testResult;
      }
    }

    // Add tool results to conversation
    messages.push({ role: "user", content: toolResultBlocks });

    // If the agent reported a result, we're done
    if (finalTestResult) {
      return finalTestResult;
    }
  }

  return {
    passed: false,
    message: `Agent exceeded maximum iterations (${MAX_ITERATIONS}) without reporting a result.`,
  };
}
