/**
 * HTTP route handlers for diagnostics export and dictation processing.
 *
 * Handles diagnostics export and dictation processing requests.
 */

import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import archiver from "archiver";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";

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
import { resolveConversationId } from "../../memory/conversation-key-store.js";
import { getDb } from "../../memory/db.js";
import {
  llmRequestLogs,
  llmUsageEvents,
  messages,
  toolInvocations,
} from "../../memory/schema.js";
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
// Diagnostics export — redaction helpers
// ---------------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 500;

const REDACT_PATTERNS = [
  /\b(sk|key|api[_-]?key|token|secret|password|passwd|credential)[_\-]?[a-zA-Z0-9]{16,}\b/gi,
  /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi,
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
];

function redact(text: string): string {
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function truncateAndRedact(text: string): string {
  const truncated =
    text.length > MAX_CONTENT_LENGTH
      ? text.slice(0, MAX_CONTENT_LENGTH) + "...[truncated]"
      : text;
  return redact(truncated);
}

const SENSITIVE_KEYS = new Set([
  "api_key",
  "apikey",
  "api-key",
  "authorization",
  "x-api-key",
  "secret",
  "password",
  "token",
  "credential",
  "credentials",
]);

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value != null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Crash report discovery
// ---------------------------------------------------------------------------

const CRASH_REPORT_EXTENSIONS = new Set([".crash", ".ips", ".diag"]);
const CRASH_REPORT_TAR_GZ = ".tar.gz";
const CRASH_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function findRecentCrashReports(): string[] {
  const diagnosticReportsDir = join(
    homedir(),
    "Library",
    "Logs",
    "DiagnosticReports",
  );

  try {
    const entries = readdirSync(diagnosticReportsDir);
    const now = Date.now();
    const results: string[] = [];

    for (const entry of entries) {
      // Case-insensitive prefix match for "vellum-assistant"
      if (!entry.toLowerCase().startsWith("vellum-assistant")) continue;

      // Check extension
      const lowerEntry = entry.toLowerCase();
      const hasValidExt =
        CRASH_REPORT_EXTENSIONS.has(
          lowerEntry.slice(lowerEntry.lastIndexOf(".")),
        ) || lowerEntry.endsWith(CRASH_REPORT_TAR_GZ);

      if (!hasValidExt) continue;

      const filePath = join(diagnosticReportsDir, entry);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
        if (now - stat.mtimeMs > CRASH_REPORT_MAX_AGE_MS) continue;
        results.push(filePath);
      } catch {
        // Skip files we can't stat
      }
    }

    return results;
  } catch {
    // Directory doesn't exist or can't be read — not an error
    return [];
  }
}

// ---------------------------------------------------------------------------
// Diagnostics export handler
// ---------------------------------------------------------------------------

async function handleDiagnosticsExport(body: {
  conversationId?: string;
  anchorMessageId?: string;
}): Promise<Response> {
  if (!body.conversationId) {
    return httpError("BAD_REQUEST", "conversationId is required", 400);
  }

  // The client may send a conversation key (client-side UUID) rather than
  // the daemon's internal conversation ID. Resolve to the canonical ID.
  const conversationId =
    resolveConversationId(body.conversationId) ?? body.conversationId;
  const { anchorMessageId } = body;

  try {
    const db = getDb();

    // 1. Find the anchor message.
    // Try in order: specific ID → most recent assistant message → any message.
    // The final fallback handles the race condition where the user clicks
    // "export" before message_complete fires and the assistant message has
    // been persisted — the user message and in-flight tool/usage data are
    // still captured.
    let anchorMessage;
    let anchorIsFallback = false;
    if (anchorMessageId) {
      anchorMessage = db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.id, anchorMessageId),
            eq(messages.conversationId, conversationId),
          ),
        )
        .get();
    }
    if (!anchorMessage) {
      anchorMessage = db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.role, "assistant"),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(1)
        .get();
    }
    if (!anchorMessage) {
      anchorMessage = db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(1)
        .get();
      anchorIsFallback = true;
    }

    // 2. Compute the export time range.
    // When an anchor message exists, scope from the earliest message in the
    // conversation through the anchor so the full conversation context is
    // captured. When no messages exist at all (empty conversation or race
    // condition), use the current timestamp so the export still captures any
    // in-flight usage/tool data.
    const now = Date.now();
    let rangeEnd: number;
    let rangeStart: number;
    let usageRangeEnd: number;

    if (anchorMessage) {
      const earliestMessage = db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt))
        .limit(1)
        .get();

      rangeStart = earliestMessage?.createdAt ?? anchorMessage.createdAt - 2000;

      // When the anchor was selected via the fallback "any message" path
      // (because the assistant reply hasn't been persisted yet), extend the
      // range to the current time so in-flight tool invocations and usage
      // recorded after the user message are captured. An explicit anchor to a
      // non-assistant message uses the message's own timestamp.
      rangeEnd = anchorIsFallback ? now : anchorMessage.createdAt;
      usageRangeEnd = anchorIsFallback
        ? now + 5000
        : anchorMessage.createdAt + 5000;
    } else {
      // No messages at all — use the current time so we capture any
      // in-flight LLM usage or tool invocations.
      rangeStart = now - 60_000;
      rangeEnd = now;
      usageRangeEnd = now + 5000;
    }

    // 3. Query all messages in the range
    const rangeMessages = db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          gte(messages.createdAt, rangeStart),
          lte(messages.createdAt, rangeEnd),
        ),
      )
      .orderBy(messages.createdAt)
      .all();

    // 4. Query tool invocations in the range
    const rangeToolInvocations = db
      .select()
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.conversationId, conversationId),
          gte(toolInvocations.createdAt, rangeStart),
          lte(toolInvocations.createdAt, rangeEnd),
        ),
      )
      .orderBy(toolInvocations.createdAt)
      .all();

    // 5. Query LLM usage events
    const rangeUsageEvents = db
      .select()
      .from(llmUsageEvents)
      .where(
        and(
          eq(llmUsageEvents.conversationId, conversationId),
          gte(llmUsageEvents.createdAt, rangeStart),
          lte(llmUsageEvents.createdAt, usageRangeEnd),
        ),
      )
      .orderBy(llmUsageEvents.createdAt)
      .all();

    // 5b. Query raw LLM request/response logs
    const rangeRequestLogs = db
      .select()
      .from(llmRequestLogs)
      .where(
        and(
          eq(llmRequestLogs.conversationId, conversationId),
          gte(llmRequestLogs.createdAt, rangeStart),
          lte(llmRequestLogs.createdAt, usageRangeEnd),
        ),
      )
      .orderBy(llmRequestLogs.createdAt)
      .all();

    // 6. Write export files to a temp directory
    const exportId = `diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
    const tempDir = join(tmpdir(), exportId);
    mkdirSync(tempDir, { recursive: true });

    try {
      const manifest = {
        version: "1.1",
        exportedAt: new Date().toISOString(),
        conversationId,
        messageId: anchorMessage?.id ?? null,
      };
      writeFileSync(
        join(tempDir, "manifest.json"),
        JSON.stringify(manifest, null, 2),
      );

      const messagesLines = rangeMessages.map((m) =>
        JSON.stringify({
          id: m.id,
          conversationId: m.conversationId,
          role: m.role,
          content: truncateAndRedact(m.content),
          createdAt: m.createdAt,
        }),
      );
      writeFileSync(
        join(tempDir, "messages.jsonl"),
        messagesLines.join("\n") + (messagesLines.length > 0 ? "\n" : ""),
      );

      const toolLines = rangeToolInvocations.map((t) =>
        JSON.stringify({
          id: t.id,
          conversationId: t.conversationId,
          toolName: t.toolName,
          input: truncateAndRedact(t.input),
          result: truncateAndRedact(t.result),
          decision: t.decision,
          riskLevel: t.riskLevel,
          durationMs: t.durationMs,
          createdAt: t.createdAt,
        }),
      );
      writeFileSync(
        join(tempDir, "tool_invocations.jsonl"),
        toolLines.join("\n") + (toolLines.length > 0 ? "\n" : ""),
      );

      const usageLines = rangeUsageEvents.map((u) =>
        JSON.stringify({
          id: u.id,
          conversationId: u.conversationId,
          actor: u.actor,
          provider: u.provider,
          model: u.model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheCreationInputTokens: u.cacheCreationInputTokens,
          cacheReadInputTokens: u.cacheReadInputTokens,
          estimatedCostUsd: u.estimatedCostUsd,
          pricingStatus: u.pricingStatus,
          createdAt: u.createdAt,
        }),
      );
      writeFileSync(
        join(tempDir, "usage.jsonl"),
        usageLines.join("\n") + (usageLines.length > 0 ? "\n" : ""),
      );

      const requestLogLines = rangeRequestLogs.map((r) => {
        let request: unknown;
        let response: unknown;
        try {
          request = JSON.parse(r.requestPayload);
        } catch {
          request = r.requestPayload;
        }
        try {
          response = JSON.parse(r.responsePayload);
        } catch {
          response = r.responsePayload;
        }
        return JSON.stringify({
          id: r.id,
          conversationId: r.conversationId,
          request: redactDeep(request),
          response: redactDeep(response),
          createdAt: r.createdAt,
        });
      });
      writeFileSync(
        join(tempDir, "llm_requests.jsonl"),
        requestLogLines.join("\n") + (requestLogLines.length > 0 ? "\n" : ""),
      );

      // 7. Zip the temp directory
      const downloadsDir = join(homedir(), "Downloads");
      mkdirSync(downloadsDir, { recursive: true });
      const zipFilename = `${exportId}.zip`;
      const zipPath = join(downloadsDir, zipFilename);

      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(zipPath);
        const archive = archiver("zip", { zlib: { level: 9 } });

        output.on("close", () => resolve());
        output.on("error", (err: Error) => reject(err));
        archive.on("error", (err: Error) => reject(err));
        archive.on("warning", (err: Error) => {
          log.warn({ err }, "Archiver warning during diagnostics export");
        });

        archive.pipe(output);
        archive.directory(tempDir, false);

        // Add recent crash report files under crash-reports/.
        // Text-based crash files (.crash, .ips, .diag) are redacted using the
        // same patterns as conversation data. Binary archives (.tar.gz) are
        // added as-is since they can't be meaningfully text-redacted.
        const crashReportFiles = findRecentCrashReports();
        for (const filePath of crashReportFiles) {
          try {
            const fileName = basename(filePath);
            if (fileName.toLowerCase().endsWith(CRASH_REPORT_TAR_GZ)) {
              archive.file(filePath, { name: "crash-reports/" + fileName });
            } else {
              const content = readFileSync(filePath, "utf-8");
              archive.append(redact(content), {
                name: "crash-reports/" + fileName,
              });
            }
          } catch {
            // Skip files that can't be read
          }
        }

        archive.finalize();
      });

      log.info(
        { conversationId, zipPath, messageCount: rangeMessages.length },
        "Diagnostics export completed via HTTP",
      );

      return Response.json({ success: true, filePath: zipPath });
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err, conversationId }, "Failed to export diagnostics");
    return httpError(
      "INTERNAL_ERROR",
      `Failed to export diagnostics: ${errorMessage}`,
      500,
    );
  }
}

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
      endpoint: "diagnostics/export",
      method: "POST",
      policyKey: "diagnostics/export",
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          conversationId?: string;
          anchorMessageId?: string;
        };
        return handleDiagnosticsExport(body);
      },
    },
    {
      endpoint: "dictation",
      method: "POST",
      policyKey: "dictation",
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
