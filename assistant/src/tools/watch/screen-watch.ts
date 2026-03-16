import crypto from "node:crypto";

import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";
import type { WatchSession } from "./watch-state.js";
import {
  fireWatchCompletionNotifier,
  fireWatchStartNotifier,
  getActiveWatchSession,
  watchSessions,
} from "./watch-state.js";

const log = getLogger("screen-watch");

const SHORT_HASH_LENGTH = 8;

class ScreenWatchTool implements Tool {
  name = "start_screen_watch";
  description =
    "Start observing the screen at regular intervals for a specified duration. Captures OCR text from the active window and provides periodic commentary.";
  category = "observation";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          duration_minutes: {
            type: "number",
            description: "How long to watch in minutes (1-15, default 5)",
          },
          interval_seconds: {
            type: "number",
            description: "Seconds between screen captures (5-30, default 10)",
          },
          focus_area: {
            type: "string",
            description: "What to focus on observing",
          },
        },
        required: ["focus_area"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const { conversationId } = context;

    // Validate focus_area
    const focusArea =
      typeof input.focus_area === "string" && input.focus_area.length > 0
        ? input.focus_area
        : undefined;

    if (!focusArea) {
      return {
        content: "Error: focus_area is required and must be a non-empty string",
        isError: true,
      };
    }

    // Clamp duration to 1-15 minutes
    let durationMinutes =
      typeof input.duration_minutes === "number" ? input.duration_minutes : 5;
    durationMinutes = Math.max(1, Math.min(15, durationMinutes));

    // Clamp interval to 5-30 seconds
    let intervalSeconds =
      typeof input.interval_seconds === "number" ? input.interval_seconds : 10;
    intervalSeconds = Math.max(5, Math.min(30, intervalSeconds));

    // Check for existing active session
    const existing = getActiveWatchSession(conversationId);
    if (existing) {
      return {
        content: `Error: An active watch session already exists for this conversation (watchId: ${existing.watchId}, focus: "${existing.focusArea}"). Cancel or wait for it to complete before starting a new one.`,
        isError: true,
      };
    }

    // Generate watchId
    const watchId = crypto.randomUUID().slice(0, SHORT_HASH_LENGTH);
    const now = Date.now();
    const durationSeconds = durationMinutes * 60;

    // Create session
    const session: WatchSession = {
      watchId,
      conversationId,
      focusArea,
      durationSeconds,
      intervalSeconds,
      observations: [],
      commentaryCount: 0,
      status: "active",
      startedAt: now,
    };

    // Store in sessions map
    watchSessions.set(watchId, session);

    // Fire start notifier
    fireWatchStartNotifier(conversationId, session);

    // Set timeout for duration expiry
    session.timeoutHandle = setTimeout(() => {
      session.status = "completing";
      session.timeoutHandle = undefined;
      log.info(
        { watchId, focusArea },
        "Watch session duration expired, marking as completing",
      );
      fireWatchCompletionNotifier(conversationId, session);
    }, durationSeconds * 1000);

    log.info(
      { watchId, conversationId, focusArea, durationMinutes, intervalSeconds },
      "Screen watch session started",
    );

    const expectedCaptures = Math.floor(durationSeconds / intervalSeconds);
    const content = [
      `Screen watch started (watchId: ${watchId})`,
      `Focus: ${focusArea}`,
      `Duration: ${durationMinutes} minute${durationMinutes !== 1 ? "s" : ""}`,
      `Interval: every ${intervalSeconds} seconds`,
      `Expected captures: ~${expectedCaptures}`,
      `Started at: ${new Date(now).toISOString()}`,
      `Expected end: ${new Date(now + durationSeconds * 1000).toISOString()}`,
    ].join("\n");

    return { content, isError: false };
  }
}

export const screenWatchTool = new ScreenWatchTool();
