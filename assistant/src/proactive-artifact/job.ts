/**
 * Proactive artifact background job orchestrator.
 *
 * Runs a multi-phase pipeline:
 *   1. Collect bounded transcript from the conversation
 *   2. Phase 1 — Decision: ask the LLM whether to build an artifact
 *   3. Phase 2 — Build: create the artifact (app or document)
 *   4. Post-build message copy: generate a user-facing message
 *   5. Message injection: deliver the message to the conversation
 *   6. Notification: emit a notification signal
 *
 * Build failure = total silence (no message, no notification).
 * Provider unavailable = silent return.
 */

import { v4 as uuid } from "uuid";

import { processMessage } from "../daemon/process-message.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../daemon/trust-context.js";
import { saveDocument } from "../documents/document-store.js";
import {
  addAppConversationId,
  listApps,
  listAppsByConversation,
} from "../memory/app-store.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { rawAll } from "../memory/raw-query.js";
import type { BroadcastFn } from "../notifications/adapters/macos.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import {
  extractText,
  getConfiguredProvider,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";
import { injectAuxAssistantMessage } from "./aux-message-injector.js";
import {
  buildDecisionPrompt,
  formatTranscript,
  parseDecisionOutput,
} from "./decision.js";
import { buildMessageCopyPrompt, parseMessageCopy } from "./message-copy.js";
import { releaseProactiveArtifactClaim } from "./trigger-state.js";

const log = getLogger("proactive-artifact-job");

export async function runProactiveArtifactJob(params: {
  conversationId: string;
  userMessageCutoff: number;
  assistantMessageId: string | undefined;
  suppressAppBuild?: boolean;
  broadcastMessage: BroadcastFn;
}): Promise<void> {
  let buildSucceeded = false;
  try {
    // ── Collect transcript (bounded) ────────────────────────────────
    const rows = rawAll<{ role: string; content: string }>(
      `SELECT m.role, m.content FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       WHERE c.conversation_type = 'standard'
         AND (m.created_at <= ? OR m.id = ?)
       ORDER BY m.created_at ASC`,
      params.userMessageCutoff,
      params.assistantMessageId ?? "",
    );

    if (rows.length === 0) {
      log.info(
        { conversationId: params.conversationId },
        "No messages found for proactive artifact transcript",
      );
      releaseProactiveArtifactClaim();
      return;
    }

    const transcript = formatTranscript(rows);

    // ── Phase 1 — Decision ──────────────────────────────────────────
    const decisionProvider = await getConfiguredProvider(
      "proactiveArtifactDecision",
    );
    if (!decisionProvider) {
      log.info("Decision provider unavailable; skipping proactive artifact");
      releaseProactiveArtifactClaim();
      return;
    }

    const decisionResponse = await decisionProvider.sendMessage([
      {
        role: "user",
        content: [{ type: "text", text: buildDecisionPrompt(transcript) }],
      },
    ]);
    const decisionText = extractText(decisionResponse);
    const decision = parseDecisionOutput(decisionText);

    if (!decision) {
      log.warn(
        { conversationId: params.conversationId },
        "Malformed decision output from proactive artifact LLM",
      );
      releaseProactiveArtifactClaim();
      return;
    }

    if (!decision.shouldBuild) {
      log.info(
        {
          conversationId: params.conversationId,
          skipReason: decision.skipReason,
        },
        "Proactive artifact decision: skip",
      );
      releaseProactiveArtifactClaim();
      return;
    }

    // ── Phase 2 — Build ─────────────────────────────────────────────
    const { artifactType, artifactTitle, artifactDescription } = decision;
    let artifactId: string;

    if (artifactType === "app") {
      const suppressionReason = getAppBuildSuppressionReason({
        conversationId: params.conversationId,
        userMessageCutoff: params.userMessageCutoff,
        suppressAppBuild: params.suppressAppBuild,
      });
      if (suppressionReason) {
        log.info(
          {
            conversationId: params.conversationId,
            artifactTitle,
            suppressionReason,
          },
          "Skipping proactive app build because foreground app work already exists",
        );
        return;
      }
      artifactId = await buildApp({
        artifactTitle,
        artifactDescription,
        conversationId: params.conversationId,
      });
    } else {
      artifactId = await buildDocument({
        artifactTitle,
        artifactDescription,
        conversationId: params.conversationId,
        transcript,
      });
    }
    buildSucceeded = true;

    // ── Post-build message copy ─────────────────────────────────────
    let messageCopy: string;
    const fallbackMessage = `I made something for you — ${artifactTitle}. Take a look when you get a chance.`;

    try {
      const copyProvider = await getConfiguredProvider(
        "proactiveArtifactBuild",
      );
      if (!copyProvider) {
        messageCopy = fallbackMessage;
      } else {
        const copyResponse = await copyProvider.sendMessage([
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildMessageCopyPrompt({
                  artifactType,
                  artifactTitle,
                  artifactId,
                  transcript,
                }),
              },
            ],
          },
        ]);
        const copyText = extractText(copyResponse);
        messageCopy = parseMessageCopy(copyText) ?? fallbackMessage;
      }
    } catch (err) {
      log.warn({ err }, "Message copy generation failed; using fallback");
      messageCopy = fallbackMessage;
    }

    // ── Message injection ───────────────────────────────────────────
    await injectAuxAssistantMessage({
      conversationId: params.conversationId,
      text: messageCopy,
      broadcastMessage: params.broadcastMessage,
    });

    // ── Notification ────────────────────────────────────────────────
    await emitNotificationSignal({
      sourceEventName: "activity.complete",
      sourceChannel: "vellum",
      sourceContextId: params.conversationId,
      attentionHints: {
        urgency: "medium",
        requiresAction: false,
        isAsyncBackground: true,
        visibleInSourceNow: false,
      },
      contextPayload: {
        summary: `${artifactTitle} is ready`,
      },
      dedupeKey: "proactive-artifact",
    });
  } catch (err) {
    log.error(
      { err, conversationId: params.conversationId },
      "Proactive artifact job failed",
    );
    if (!buildSucceeded) {
      releaseProactiveArtifactClaim();
    }
  }
}

// ── App build ─────────────────────────────────────────────────────────

function getAppBuildSuppressionReason(params: {
  conversationId: string;
  userMessageCutoff: number;
  suppressAppBuild?: boolean;
}): string | null {
  if (params.suppressAppBuild) {
    return "foreground-turn-used-app-tool";
  }

  const recentApps = listAppsByConversation(params.conversationId).filter(
    (app) =>
      app.createdAt >= params.userMessageCutoff ||
      app.updatedAt >= params.userMessageCutoff,
  );
  if (recentApps.length > 0) {
    return "conversation-has-recent-app-activity";
  }

  return null;
}

async function buildApp(params: {
  artifactTitle: string;
  artifactDescription: string;
  conversationId: string;
}): Promise<string> {
  const conversation = bootstrapConversation({
    conversationType: "background",
    source: "proactive_artifact",
    groupId: "system:background",
    origin: "heartbeat",
    systemHint: "Proactive artifact build",
  });

  const buildStartedAt = Date.now();

  const prompt = `Load the app-builder skill, then create an app with the following details:
- Title: ${params.artifactTitle}
- Description: ${params.artifactDescription}
- auto_open: false

For apps, keep scope tight — single file or 2-3 files max, under ~300 lines. Simple and immediately useful beats impressive and slow. This runs as a background job with limited credits — scope accordingly.

Write the source code following the skill instructions, then compile via app_refresh.`;

  await processMessage(conversation.id, prompt, undefined, {
    callSite: "proactiveArtifactBuild",
    trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
  });

  // Query app store for newly created app
  const apps = listApps();
  const match = apps.find(
    (app) =>
      app.createdAt >= buildStartedAt &&
      app.name
        .trim()
        .toLowerCase()
        .includes(params.artifactTitle.trim().toLowerCase()),
  );

  if (!match) {
    throw new Error(
      `App build completed but no matching app found (title: ${params.artifactTitle})`,
    );
  }

  addAppConversationId(match.id, params.conversationId);

  return match.id;
}

// ── Document build ────────────────────────────────────────────────────

async function buildDocument(params: {
  artifactTitle: string;
  artifactDescription: string;
  conversationId: string;
  transcript: string;
}): Promise<string> {
  const buildProvider = await getConfiguredProvider("proactiveArtifactBuild");
  if (!buildProvider) {
    throw new Error("Build provider unavailable for document generation");
  }

  const buildResponse = await buildProvider.sendMessage([
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Generate a well-structured markdown document based on the following specification.

Title: ${params.artifactTitle}
Description: ${params.artifactDescription}

Original conversation for context:
${params.transcript}

Write the complete markdown content. Make it specific, actionable, and tailored to the user's situation.`,
        },
      ],
    },
  ]);

  const generatedMarkdown = extractText(buildResponse);
  if (!generatedMarkdown) {
    throw new Error("Build provider returned empty content for document");
  }

  const surfaceId = `doc-${uuid()}`;
  const wordCount = generatedMarkdown
    .split(/\s+/)
    .filter((w) => w.length > 0).length;

  const result = saveDocument({
    surfaceId,
    conversationId: params.conversationId,
    title: params.artifactTitle,
    content: generatedMarkdown,
    wordCount,
  });

  if (!result.success) {
    throw new Error(`Failed to save document: ${result.error}`);
  }

  return surfaceId;
}
