/**
 * Anthropic agent loop for executing Playwright test cases.
 *
 * Takes a markdown test case, sends it to Claude with available browser tools,
 * and runs the agent in a loop until a test result is reported.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import path from "path";

import Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import { TOOL_DEFINITIONS, createToolExecutor, type TestResult } from "./tools";

// ── Constants ───────────────────────────────────────────────────────

const MAX_ITERATIONS = 1000;
const MAX_TEST_DURATION_MS = 5 * 60 * 1000; // 5 minutes per test
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 5000;
const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are a QA test automation agent for a desktop application. Your job is to execute end-to-end test cases described in markdown and verify the expected outcomes.

The test cases are written from the perspective of a non-technical end user. You must translate each plain-language step into the appropriate tool calls. Do not expect CSS selectors, shell commands, or technical details in the test steps — figure out the right actions yourself.

Available tool categories:
- App lifecycle: launch_app — launches the desktop application.
- Chat interaction: send_chat_message, read_chat_messages — PREFERRED tools for chatting with the assistant. send_chat_message handles focusing the text field, typing, pressing Enter, and waiting for the response in one step. read_chat_messages reads all text from the main window using \`entire contents\` so it reliably finds all messages regardless of scroll position or nesting. ALWAYS use these instead of manually typing into the text field with applescript.
- Desktop interaction: applescript, run_shell, wait — interact with the native macOS app via System Events (clicking buttons, typing text, reading accessibility trees, taking screenshots). Use applescript for UI interactions OTHER than sending/reading chat messages.
- Secrets: type_env_var — type the value of an environment variable (e.g., ANTHROPIC_API_KEY) into the focused input field without exposing the secret in the conversation.
- Secure Credentials: fill_secure_credential — fill a floating "Secure Credential" popup panel with an environment variable value and click Save. ALWAYS use this tool (not applescript or type_env_var) whenever you see a "Secure Credential" panel appear. The panel is a small floating window (~400x270px) separate from the main app window. The tool automatically finds the panel, locates the input field regardless of nesting depth, types the value, and clicks Save. If it fails on the first attempt, wait 1 second and try again — the panel may still be animating.
- Browser tools: goto, click, fill, check, get_text, get_page_content, get_current_url, screenshot — for web-based UI testing.
- Utility tools: http_request, report_result — for API calls and reporting test outcomes.

Rules:
- Execute each step described in the markdown test case in order.
- Use applescript with System Events to interact with native macOS UI elements (buttons, text fields, etc.). Use the accessibility tree to discover element names and hierarchy.
- When verifying UI state, take screenshots or inspect the accessibility tree as needed — the test steps won't tell you to do this explicitly.
- Some actions (like launching an app) may take time. Be patient and retry if an element is not yet available.
- Never embed secrets directly in test content. Use type_env_var to type secret values (e.g., API keys) from environment variables without exposing them.
- After completing all steps, verify each expected outcome.
- You MUST call report_result exactly once when done, indicating whether the test passed or failed.
- CRITICAL: Do NOT report a test as "passed" unless you have completed AND verified EVERY step and expected outcome in the test case. Partial completion is ALWAYS a failure. If you run out of time or budget before finishing all steps, report FAIL with details about which steps were not completed.
- If a step fails (tool returns an error), try to recover once. If it still fails, report the test as failed with details.
- You have a strict 5-minute time limit and a limited iteration budget. Work efficiently.

Efficiency guidelines (CRITICAL — work as fast as possible):
- Combine multiple actions in a single applescript call when possible (e.g., dump the tree AND click a button in one script).
- Do NOT dump the full accessibility tree every single time. Dump it once when you first encounter a new screen, then reference the elements you found. Only re-dump if your element reference fails.
- When waiting for the app or assistant to respond, use a SINGLE wait call of 3-5 seconds, then check. Do not use many short waits.
- Avoid redundant screenshots — only take a screenshot when you need visual confirmation that cannot be obtained from the accessibility tree.
- If you are stuck on a step for more than 3-4 attempts, report the test as failed rather than continuing to retry.
- Issue the report_result call AS SOON AS you have enough evidence to make a pass/fail determination. Do not perform extra verification beyond what the test requires.

Chat interaction patterns (IMPORTANT):
- ALWAYS use send_chat_message to send messages in the chat. Do NOT manually click the text field and type with applescript — the text field focus is unreliable and wastes iterations.
- ALWAYS use read_chat_messages to read the conversation. Do NOT use narrow queries like "every static text of UI element 1 of scroll area 2" — these miss newly-added messages. The read_chat_messages tool uses "entire contents" which finds everything regardless of nesting.
- After send_chat_message returns, check if WINDOWS count > 1 — this means a popup (like Secure Credential) appeared during the response.
- If you need to check whether a popup appeared without sending a message, use read_chat_messages — it reports the window count.
- The assistant may take 5-15 seconds to respond. send_chat_message waits automatically (default 10s). If you need to wait longer, call wait() then read_chat_messages.

AppleScript tips (avoid common errors):
- Dump the accessibility tree (entire contents of window 1) the FIRST TIME you see a new screen. Cache the structure mentally and reference elements directly after that.
- Static text elements are read-only — do not try to set their value.
- Use "click" and "keystroke" for input, not "set value" on non-editable elements.
- Ensure proper AppleScript syntax: use "of" for hierarchy, quote strings, and avoid bare ordinal words like "1st", "2nd", "3rd" outside of proper AppleScript context.
- If an element reference fails with "Invalid index", re-inspect the accessibility tree to find the correct path.
- Combine inspection and action: you can dump the tree, parse it, AND click a button all in one AppleScript call.
- NEVER use "result" as a variable name — it is RESERVED in AppleScript. Use "myResult", "output", or another name.
- NEVER use short variable names like "st", "el", or other abbreviations that may conflict with AppleScript keywords. Use descriptive names like "staticTextEl", "elemRef".
- Use "every static text of ..." (NOT "static text elements of ..."). Similarly, use "every button of ..." (NOT "button elements of ...").
- When a popup or new window appears, the window numbering may change. Always re-query the window list and inspect contents to find the right window.

TEMPORARY WORKAROUNDS:
The following are temporary workarounds to unblock e2e development. We hope to remove these once the app catches up.
- Whenever the App says the AI Provider is rate limiting requests, always wait 60s before clicking Retry.`;

// ── Agent Loop ──────────────────────────────────────────────────────

export interface AgentOptions {
  testContent: string;
  page: Page;
  screenshotDir: string;
  traceLogPath?: string;
  verbose?: boolean;
  /** Playwright parallel worker index (0-based). Used to isolate temp files across workers. */
  workerIndex?: number;
}

export async function runAgent(options: AgentOptions): Promise<TestResult> {
  const controller = new AbortController();
  const { signal } = controller;

  const timeoutId = setTimeout(() => controller.abort(), MAX_TEST_DURATION_MS);

  try {
    return await runAgentLoop(options, signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

function traceLog(logPath: string | undefined, entry: string): void {
  if (!logPath) return;
  const ts = new Date().toISOString();
  appendFileSync(logPath, `[${ts}] ${entry}\n`);
}

async function runAgentLoop(options: AgentOptions, signal: AbortSignal): Promise<TestResult> {
  const { testContent, page, screenshotDir, traceLogPath, verbose = false, workerIndex = 0 } = options;

  // Initialize trace log
  if (traceLogPath) {
    mkdirSync(path.dirname(traceLogPath), { recursive: true });
    writeFileSync(traceLogPath, "");
    traceLog(traceLogPath, "Agent started");
  }

  const executeTool = createToolExecutor(screenshotDir, workerIndex);
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Execute the following test case:\n\n${testContent}`,
    },
  ];

  const startTime = Date.now();

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (signal.aborted) {
      return {
        passed: false,
        message: `Test timed out after ${MAX_TEST_DURATION_MS / 1000}s.`,
        reasoning: `The agent did not complete within the ${MAX_TEST_DURATION_MS / 1000}s time limit after ${iteration} iterations. The test was aborted before the agent could call report_result.`,
      };
    }

    if (verbose) {
      console.log(`  [agent] iteration ${iteration + 1}/${MAX_ITERATIONS}`);
    }

    let response: Anthropic.Message;
    for (let retry = 0; ; retry++) {
      if (signal.aborted) {
        return {
          passed: false,
          message: `Test timed out after ${MAX_TEST_DURATION_MS / 1000}s.`,
          reasoning: `The agent timed out during an API call on iteration ${iteration + 1}. The test was aborted before completion.`,
        };
      }

      try {
        const stream = client.messages.stream({
          model: MODEL,
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
          tools: TOOL_DEFINITIONS,
          messages,
        });
        response = await stream.finalMessage();
        break;
      } catch (err: unknown) {
        if (signal.aborted) {
          return {
            passed: false,
            message: `Test timed out after ${MAX_TEST_DURATION_MS / 1000}s.`,
            reasoning: `The agent timed out during an API call on iteration ${iteration + 1}. The test was aborted before completion.`,
          };
        }
        const isRetryable =
          err instanceof Anthropic.APIError &&
          (err.status === 429 || err.status === 529 || err.status === 503);
        if (!isRetryable || retry >= MAX_RETRIES) {
          throw err;
        }
        const delay = INITIAL_RETRY_DELAY_MS * 2 ** retry;
        if (verbose) {
          console.log(`  [agent] API ${err.status} — retrying in ${delay / 1000}s (attempt ${retry + 1}/${MAX_RETRIES})`);
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Collect assistant content blocks
    const assistantContent = response.content;

    for (const block of assistantContent) {
      if (block.type === "text") {
        traceLog(traceLogPath, `[iter ${iteration + 1}/${MAX_ITERATIONS}] TEXT ${block.text}`);
        if (verbose) console.log(`  [agent] text: ${block.text}`);
      } else if (block.type === "tool_use") {
        if (verbose) console.log(`  [agent] tool_use: ${block.name}(${JSON.stringify(block.input)})`);
      }
    }

    // Add assistant message to conversation
    messages.push({ role: "assistant", content: assistantContent });

    // If the model stopped without tool use, the test didn't report a result
    if (response.stop_reason !== "tool_use") {
      const lastText = assistantContent
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return {
        passed: false,
        message: "Agent stopped without reporting a test result (no report_result call).",
        reasoning: lastText || "The model produced no text before stopping.",
      };
    }

    // Process all tool calls
    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    let finalTestResult: TestResult | undefined;

    for (const block of assistantContent) {
      if (block.type !== "tool_use") continue;

      if (signal.aborted) {
        return {
          passed: false,
          message: `Test timed out after ${MAX_TEST_DURATION_MS / 1000}s.`,
          reasoning: `The agent timed out while processing tool call '${block.name}' on iteration ${iteration + 1}.`,
        };
      }

      traceLog(traceLogPath, `[iter ${iteration + 1}/${MAX_ITERATIONS}] CALL ${block.name}(${JSON.stringify(block.input)})`);

      const { result, testResult } = await executeTool(
        page,
        block.name,
        block.input as Record<string, unknown>,
      );

      traceLog(traceLogPath, `RESULT ${block.name}: ${result.success ? "ok" : "FAIL"} — ${result.data}`);

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

    // Build the user message with tool results and optional budget warning
    const userContent: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [...toolResultBlocks];

    // Inject budget awareness into the tool results message
    const elapsedMs = Date.now() - startTime;
    const remainingIterations = MAX_ITERATIONS - iteration - 1; // iterations left after this one
    const remainingSecs = Math.max(0, Math.floor((MAX_TEST_DURATION_MS - elapsedMs) / 1000));

    if (remainingIterations <= 5 || remainingSecs <= 30) {
      userContent.push({
        type: "text",
        text: `⚠️ URGENT: You have ${remainingIterations} iterations and ~${remainingSecs}s remaining. You MUST call report_result NOW with your best assessment of pass/fail. Do not perform any more test steps.`,
      });
    } else if (remainingIterations <= 15 || remainingSecs <= 90) {
      userContent.push({
        type: "text",
        text: `⏱️ Budget check: ${remainingIterations} iterations and ~${remainingSecs}s remaining. Wrap up your verification and call report_result soon.`,
      });
    }

    messages.push({ role: "user", content: userContent });

    // If the agent reported a result, we're done
    if (finalTestResult) {
      return finalTestResult;
    }
  }

  return {
    passed: false,
    message: `Agent exceeded maximum iterations (${MAX_ITERATIONS}) without reporting a result.`,
    reasoning: `The agent ran for ${MAX_ITERATIONS} iterations without calling report_result. This likely indicates an infinite loop or the agent getting stuck.`,
  };
}
