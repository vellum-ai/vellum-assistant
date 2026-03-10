/**
 * Anthropic agent loop for executing Playwright test cases.
 *
 * Takes a markdown test case, sends it to Claude with available browser tools,
 * and runs the agent in a loop until a test result is reported.
 */

import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
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

Available tool categories (PREFERRED tools listed first):
- Element interaction (PREFERRED for native UI): query_elements, query_and_click, query_and_type, click_element, type_into_element, wait_for_element — interact with native macOS UI elements via the Accessibility API. These tools use stable element IDs and are much more reliable than raw AppleScript. ALWAYS prefer these over applescript for clicking, typing, and reading UI state.
- App lifecycle: launch_app — launches the desktop application.
- Chat interaction: send_chat_message, read_chat_messages — PREFERRED tools for chatting with the assistant. send_chat_message handles focusing the text field, typing, pressing Enter, and waiting for the response in one step. read_chat_messages reads all text from the main window using \`entire contents\` so it reliably finds all messages regardless of scroll position or nesting. ALWAYS use these instead of manually typing into the text field.
- Secrets: type_env_var — type the value of an environment variable (e.g., ANTHROPIC_API_KEY) into an input field without exposing the secret. Accepts an optional element_id to click-to-focus before typing.
- Secure Credentials: fill_secure_credential — fill a floating "Secure Credential" popup panel with an environment variable value and click Save. ALWAYS use this tool whenever you see a "Secure Credential" panel appear.
- Desktop fallback: applescript, run_shell, wait — use applescript ONLY as a fallback for menu bar interactions, drag operations, or complex workflows that can't be done with the element-based tools above.
- Browser tools: goto, click, fill, check, get_text, get_page_content, get_current_url, screenshot — for web-based UI testing.
- Utility tools: http_request, report_result — for API calls and reporting test outcomes.

Rules:
- Execute each step described in the markdown test case in order.
- ALWAYS prefer element-based tools (query_elements, query_and_click, query_and_type, click_element, type_into_element) over raw applescript for UI interactions. These are faster, more reliable, and save iterations.
- When you need to discover what's on screen, use query_elements — it returns a compact list of interactive elements with stable IDs.
- When you need to click a button or element, use query_and_click with the button's title — it finds and clicks in ONE step.
- When you need to type into a field, use query_and_type with the field's title/placeholder — it finds, focuses, and types in ONE step.
- When waiting for an element to appear, use wait_for_element instead of manual wait + query loops.
- When verifying UI state, use query_elements to inspect the accessibility tree. Only use screenshot when you need visual confirmation that the accessibility tree cannot provide.
- Some actions (like launching an app) may take time. Be patient and retry if an element is not yet available.
- Never embed secrets directly in test content. Use type_env_var to type secret values from environment variables.
- After completing all steps, verify each expected outcome.
- You MUST call report_result exactly once when done, indicating whether the test passed or failed.
- CRITICAL: Do NOT report a test as "passed" unless you have completed AND verified EVERY step and expected outcome in the test case. Partial completion is ALWAYS a failure.
- If a step fails (tool returns an error), try to recover once. If it still fails, report the test as failed with details.
- You have a strict 5-minute time limit and a limited iteration budget. Work efficiently.

Status overlay:
- Every tool call includes an optional "summary" field. ALWAYS provide a short, human-readable summary of what the tool call does (e.g. "Click Self-host button", "Query UI elements", "Wait 3s for app to load"). This is displayed in a status overlay during test runs.

Efficiency guidelines (CRITICAL — work as fast as possible):
- Use query_and_click and query_and_type for most interactions — each replaces 3+ separate tool calls.
- After query_elements, reuse element IDs with click_element and type_into_element. Only re-query if element references become stale.
- When waiting for the app or assistant to respond, use a SINGLE wait call of 3-5 seconds, then check. Do not use many short waits.
- Avoid redundant screenshots — query_elements is faster and gives you structured data.
- If you are stuck on a step for more than 3-4 attempts, report the test as failed rather than continuing to retry.
- Issue the report_result call AS SOON AS you have enough evidence to make a pass/fail determination.

Chat interaction patterns (IMPORTANT):
- ALWAYS use send_chat_message to send messages in the chat. Do NOT manually click the text field and type — the text field focus is unreliable and wastes iterations.
- ALWAYS use read_chat_messages to read the conversation. It uses "entire contents" which finds everything regardless of nesting.
- After send_chat_message returns, check if WINDOWS count > 1 — this means a popup (like Secure Credential) appeared during the response.
- If you need to check whether a popup appeared without sending a message, use read_chat_messages — it reports the window count.
- The assistant may take 5-15 seconds to respond. send_chat_message waits automatically (default 10s). If you need to wait longer, call wait() then read_chat_messages.

AppleScript tips (only needed as fallback):
- Only use applescript for menu bar interactions, drag operations, or complex workflows that can't be done with element-based tools.
- NEVER use "result" as a variable name — it is RESERVED in AppleScript.
- NEVER use short variable names that may conflict with AppleScript keywords. Use descriptive names.
- Use "every static text of ..." (NOT "static text elements of ...").

TEMPORARY WORKAROUNDS:
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
  /** Human-readable test name shown in the e2e status overlay. */
  testName?: string;
}

interface E2EStatus {
  iteration: number;
  maxIterations: number;
  tool: string;
  summary: string;
  elapsed: string;
  testName: string;
}

function e2eStatusFilePath(testName: string): string {
  return `/tmp/vellum-e2e-status-${testName}.json`;
}

function writeE2EStatus(statusFilePath: string, status: E2EStatus): void {
  try {
    writeFileSync(statusFilePath, JSON.stringify(status));
  } catch {
    // Non-critical — overlay simply won't update.
  }
}

function clearE2EStatus(statusFilePath: string): void {
  try {
    unlinkSync(statusFilePath);
  } catch {
    // File may not exist.
  }
}

export async function runAgent(options: AgentOptions): Promise<TestResult> {
  const controller = new AbortController();
  const { signal } = controller;

  const timeoutId = setTimeout(() => controller.abort(), MAX_TEST_DURATION_MS);

  try {
    return await runAgentLoop(options, signal);
  } finally {
    clearTimeout(timeoutId);
    clearE2EStatus(e2eStatusFilePath(options.testName ?? "unknown"));
  }
}

function traceLog(logPath: string | undefined, entry: string): void {
  if (!logPath) return;
  const ts = new Date().toISOString();
  appendFileSync(logPath, `[${ts}] ${entry}\n`);
}

async function runAgentLoop(options: AgentOptions, signal: AbortSignal): Promise<TestResult> {
  const { testContent, page, screenshotDir, traceLogPath, verbose = false, workerIndex = 0, testName = "unknown" } = options;

  // Initialize trace log
  if (traceLogPath) {
    mkdirSync(path.dirname(traceLogPath), { recursive: true });
    writeFileSync(traceLogPath, "");
    traceLog(traceLogPath, "Agent started");
  }

  const executeTool = createToolExecutor(screenshotDir, workerIndex, testName);
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Execute the following test case:\n\n${testContent}`,
    },
  ];

  const startTime = Date.now();

  const statusFilePath = e2eStatusFilePath(testName);

  writeE2EStatus(statusFilePath, {
    iteration: 0,
    maxIterations: MAX_ITERATIONS,
    tool: "—",
    summary: "Starting agent...",
    elapsed: "0:00",
    testName,
  });

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

      const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
      const minutes = Math.floor(elapsedSec / 60);
      const seconds = elapsedSec % 60;
      const elapsedStr = `${minutes}:${String(seconds).padStart(2, "0")}`;

      const toolInput = block.input as Record<string, unknown>;
      const summaryText =
        typeof toolInput.summary === "string" && toolInput.summary
          ? toolInput.summary
          : block.name;

      writeE2EStatus(statusFilePath, {
        iteration: iteration + 1,
        maxIterations: MAX_ITERATIONS,
        tool: block.name,
        summary: summaryText,
        elapsed: elapsedStr,
        testName,
      });

      const { result, testResult } = await executeTool(
        page,
        block.name,
        block.input as Record<string, unknown>,
      );

      traceLog(traceLogPath, `RESULT ${block.name}: ${result.success ? "ok" : "FAIL"} — ${result.data}`);

      if (verbose) {
        console.log(`  [agent] result: ${result.success ? "ok" : "FAIL"} - ${result.data}`);
      }

      // Build tool result content — include image if the tool returned one
      if (result.imageBase64) {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: [
            { type: "text", text: result.data ?? "" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: result.imageBase64,
              },
            },
          ],
          is_error: !result.success,
        });
      } else {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.data ?? "",
          is_error: !result.success,
        });
      }

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
      clearE2EStatus(statusFilePath);
      return finalTestResult;
    }
  }

  return {
    passed: false,
    message: `Agent exceeded maximum iterations (${MAX_ITERATIONS}) without reporting a result.`,
    reasoning: `The agent ran for ${MAX_ITERATIONS} iterations without calling report_result. This likely indicates an infinite loop or the agent getting stuck.`,
  };
}
