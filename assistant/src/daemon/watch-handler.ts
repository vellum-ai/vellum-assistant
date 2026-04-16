import { recordRequestLog } from "../memory/llm-request-log-store.js";
import {
  extractText,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import type {
  WatchObservationEntry,
  WatchSession,
} from "../tools/watch/watch-state.js";
import {
  addObservation,
  fireWatchCommentaryNotifier,
  fireWatchCompletionNotifier,
  watchSessions,
} from "../tools/watch/watch-state.js";
import { getLogger } from "../util/logger.js";
import type { HandlerContext } from "./handlers/shared.js";
import type { WatchObservation } from "./message-protocol.js";

const log = getLogger("watch-handler");

/**
 * Module-level maps to store commentary/summary text (and associated LLM log
 * IDs) so that session notifier callbacks can retrieve them from the
 * WatchSession's conversationId and link logs to the persisted message.
 */
export interface WatchResult {
  text: string;
  logIds: string[];
}
export const lastCommentaryByConversation = new Map<string, WatchResult>();
export const lastSummaryByConversation = new Map<string, WatchResult>();

export async function handleWatchObservation(
  msg: WatchObservation,
  _ctx: HandlerContext,
): Promise<void> {
  try {
    log.debug(
      {
        watchId: msg.watchId,
        captureIndex: msg.captureIndex,
        appName: msg.appName,
        ocrLen: msg.ocrText?.length ?? 0,
      },
      "Received watch_observation from client",
    );

    // 1. Find the WatchSession by watchId
    const session = watchSessions.get(msg.watchId);

    // 2. If not found or not active (and not completing), log warning and return
    if (!session) {
      log.warn(
        { watchId: msg.watchId, knownWatchIds: [...watchSessions.keys()] },
        "Watch session not found for observation",
      );
      return;
    }
    if (session.status !== "active" && session.status !== "completing") {
      log.warn(
        { watchId: msg.watchId, status: session.status },
        "Watch session not active",
      );
      return;
    }

    // 3. Create a WatchObservationEntry and add it
    const entry: WatchObservationEntry = {
      ocrText: msg.ocrText,
      appName: msg.appName,
      windowTitle: msg.windowTitle,
      bundleIdentifier: msg.bundleIdentifier,
      timestamp: msg.timestamp,
      captureIndex: msg.captureIndex,
    };
    addObservation(msg.watchId, entry);
    log.debug(
      {
        watchId: msg.watchId,
        totalObservations: session.observations.length,
        status: session.status,
      },
      "Observation added to watch session",
    );

    // 4. Every 3 observations: call the LLM for live commentary
    if (session.observations.length % 3 === 0) {
      log.debug(
        { watchId: msg.watchId, observationCount: session.observations.length },
        "Triggering commentary generation (every 3rd observation)",
      );
      await generateCommentary(session);
    }

    // 5. If session is completing, generate final summary
    if (session.status === "completing") {
      log.debug(
        { watchId: msg.watchId },
        "Watch session completing — generating summary from observation handler",
      );
      session.status = "completed";
      await generateSummary(session);
    }
  } catch (err) {
    log.error(
      { err, watchId: msg.watchId },
      "Error handling watch observation",
    );
  }
}

async function generateCommentary(session: WatchSession): Promise<void> {
  try {
    const provider = await getConfiguredProvider();
    if (!provider) {
      log.warn(
        { watchId: session.watchId },
        "Configured provider unavailable for commentary generation",
      );
      return;
    }
    const lastThree = session.observations.slice(-3);
    const previousResult = lastCommentaryByConversation.get(
      session.conversationId,
    );

    const userContent = [
      `Focus area: ${session.focusArea}`,
      "",
      previousResult
        ? `Previous commentary: "${previousResult.text}"`
        : "No previous commentary yet.",
      "",
      ...lastThree.map(
        (obs, i) =>
          `Observation ${i + 1}:\n- App: ${
            obs.appName ?? "unknown"
          }\n- Window: ${obs.windowTitle ?? "unknown"}\n- Screen text: ${
            obs.ocrText
          }`,
      ),
    ].join("\n\n");

    const systemPrompt = [
      "You are a casual, friendly observer watching someone work on their computer in real time.",
      `They asked you to watch them and focus on: "${session.focusArea}".`,
      "",
      "Your job is to provide brief, natural live commentary — like a friend glancing over their shoulder.",
      "",
      "Guidelines:",
      "- Write 1-2 sentences max. Be concise and conversational.",
      "- Comment on what they are doing, patterns you notice, or interesting transitions.",
      "- Reference specific apps or content you see when relevant.",
      "- If they seem to be context-switching a lot, gently note it.",
      "- Do NOT repeat your previous commentary. Say something new or say nothing.",
      '- If nothing interesting or meaningfully different has happened since the last observations, respond with exactly "SKIP" (no quotes, no extra text).',
    ].join("\n");

    const response = await provider.sendMessage(
      [userMessage(userContent)],
      undefined,
      systemPrompt,
      {
        config: {
          callSite: "watchCommentary",
          max_tokens: 200,
        },
      },
    );

    const logIds: string[] = [];
    if (response.rawRequest && response.rawResponse) {
      try {
        const logId = recordRequestLog(
          session.conversationId,
          JSON.stringify(response.rawRequest),
          JSON.stringify(response.rawResponse),
          undefined,
          response.actualProvider ?? provider.name,
        );
        logIds.push(logId);
      } catch (err) {
        log.warn({ err }, "Failed to persist watch commentary LLM log");
      }
    }

    const commentaryText = extractText(response);

    if (commentaryText && commentaryText !== "SKIP") {
      lastCommentaryByConversation.set(session.conversationId, {
        text: commentaryText,
        logIds,
      });
      fireWatchCommentaryNotifier(session.conversationId, session);
      session.commentaryCount++;
    }
  } catch (err) {
    log.error(
      { err, watchId: session.watchId },
      "Error generating watch commentary",
    );
  }
}

export async function generateSummary(session: WatchSession): Promise<void> {
  // Guard against concurrent calls (timeout + last observation race)
  if (session.summaryInFlight) {
    log.debug(
      { watchId: session.watchId },
      "generateSummary already in flight — skipping duplicate call",
    );
    return;
  }
  session.summaryInFlight = true;

  try {
    log.debug(
      {
        watchId: session.watchId,
        conversationId: session.conversationId,
        observationCount: session.observations.length,
        commentaryCount: session.commentaryCount,
      },
      "generateSummary starting — calling LLM",
    );
    const provider = await getConfiguredProvider();
    if (!provider) {
      log.warn(
        { watchId: session.watchId },
        "Configured provider unavailable for summary generation",
      );
      lastSummaryByConversation.set(session.conversationId, {
        text: "[error] Configured provider unavailable. Check your settings.",
        logIds: [],
      });
      fireWatchCompletionNotifier(session.conversationId, session);
      return;
    }

    // Build observations text with truncation (keep most recent if >50K chars)
    let observations = session.observations;
    const totalChars = observations.reduce(
      (sum, obs) => sum + obs.ocrText.length,
      0,
    );
    let wasTruncated = false;

    if (totalChars > 50_000) {
      const trimmed: WatchObservationEntry[] = [];
      let charCount = 0;
      for (let i = observations.length - 1; i >= 0; i--) {
        charCount += observations[i].ocrText.length;
        if (charCount > 50_000) break;
        trimmed.unshift(observations[i]);
      }
      wasTruncated = trimmed.length < observations.length;
      observations = trimmed;
    }

    const elapsedMinutes = Math.round(
      (Date.now() - session.startedAt) / 60_000,
    );
    const expectedMinutes = Math.round(session.durationSeconds / 60);
    const wasCancelled = elapsedMinutes < expectedMinutes - 1;

    const userContent = [
      `Focus area: ${session.focusArea}`,
      `Observation period: ${elapsedMinutes} minute(s) (planned: ${expectedMinutes} minute(s))`,
      `Total observations: ${session.observations.length}`,
      ...(wasTruncated
        ? [
            `Note: Older observations were trimmed due to size. Showing the most recent ${observations.length} of ${session.observations.length} total.`,
          ]
        : []),
      ...(wasCancelled
        ? [
            "Note: The observation period was ended early by the user. Provide your best analysis based on the data available.",
          ]
        : []),
      "",
      "--- Observations ---",
      "",
      ...observations.map(
        (obs) =>
          `[${new Date(obs.timestamp).toISOString()}] App: ${
            obs.appName ?? "unknown"
          } | Window: ${obs.windowTitle ?? "unknown"}\n${obs.ocrText}`,
      ),
    ].join("\n\n");

    const systemPrompt = [
      "You are a productivity analyst reviewing a series of screen observations captured from a user's computer.",
      `The user asked you to watch their workflow with this focus: "${session.focusArea}".`,
      "",
      "Analyze the observations and produce a structured report using exactly these markdown sections:",
      "",
      "## Workflow Summary",
      "A high-level description (2-4 sentences) of what the user did during the observation period.",
      "",
      "## App Usage",
      "List which applications were used and roughly how much time was spent in each. Use the timestamps to estimate durations. Present as a bullet list.",
      "",
      "## Context Switching",
      "Analyze how often the user switched between different apps or tasks. Note any patterns — were switches frequent and disruptive, or natural and purposeful?",
      "",
      "## Tasks & Action Items",
      "Based on what you observed on screen, describe what tasks the user worked on. Note anything that appeared unfinished or in-progress when the session ended.",
      "",
      "## Suggestions",
      "Provide 3-5 specific, actionable things the assistant could help with based on what you observed. These should be concrete offers, not generic advice.",
      'Examples: "I could draft that email you started in Gmail", "Want me to summarize the Slack thread you were reading?", "I could help outline the document you were working on in Google Docs".',
      "",
      "Important:",
      "- Base your analysis strictly on what you can see in the observations. Do not invent details.",
      "- Reference specific apps, window titles, and content when possible.",
      "- Keep the tone helpful and professional, not judgmental.",
      ...(wasCancelled
        ? [
            "- The observation period was cut short. Acknowledge this briefly and provide the best analysis you can with the available data.",
          ]
        : []),
    ].join("\n");

    const response = await provider.sendMessage(
      [userMessage(userContent)],
      undefined,
      systemPrompt,
      {
        config: {
          callSite: "watchSummary",
          max_tokens: 2000,
        },
      },
    );

    const logIds: string[] = [];
    if (response.rawRequest && response.rawResponse) {
      try {
        const logId = recordRequestLog(
          session.conversationId,
          JSON.stringify(response.rawRequest),
          JSON.stringify(response.rawResponse),
          undefined,
          response.actualProvider ?? provider.name,
        );
        logIds.push(logId);
      } catch (err) {
        log.warn({ err }, "Failed to persist watch summary LLM log");
      }
    }

    log.debug(
      { watchId: session.watchId },
      "LLM API call completed successfully",
    );

    const summaryText = extractText(response);

    log.debug(
      { watchId: session.watchId, summaryLength: summaryText.length },
      "Summary result from Sonnet",
    );

    if (summaryText) {
      lastSummaryByConversation.set(session.conversationId, {
        text: summaryText,
        logIds,
      });
      log.debug(
        { watchId: session.watchId, conversationId: session.conversationId },
        "Firing completion notifier with summary",
      );
      fireWatchCompletionNotifier(session.conversationId, session);
    } else {
      log.warn(
        { watchId: session.watchId },
        "Summary was empty from API response",
      );
      lastSummaryByConversation.set(session.conversationId, {
        text: "[error] The API returned an empty summary. This may indicate a service issue.",
        logIds,
      });
      fireWatchCompletionNotifier(session.conversationId, session);
    }
  } catch (err) {
    log.error(
      { err, watchId: session.watchId },
      "Error generating watch summary — LLM API call failed",
    );
    const message = err instanceof Error ? err.message : String(err);
    lastSummaryByConversation.set(session.conversationId, {
      text: `[error] Summary generation failed: ${message}`,
      logIds: [],
    });
    fireWatchCompletionNotifier(session.conversationId, session);
  }
}
