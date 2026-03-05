import { mkdirSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { dirname } from "node:path";

import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import * as conversationStore from "../../memory/conversation-store.js";
import { readTextFileSync } from "../../util/fs.js";
import { getWorkspacePromptPath } from "../../util/platform.js";
import type {
  HeartbeatChecklistRead,
  HeartbeatChecklistWrite,
  HeartbeatConfig,
  HeartbeatRunNow,
  HeartbeatRunsList,
} from "../ipc-protocol.js";
import {
  CONFIG_RELOAD_DEBOUNCE_MS,
  defineHandlers,
  type HandlerContext,
  log,
} from "./shared.js";

export function handleHeartbeatConfig(
  msg: HeartbeatConfig,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    if (msg.action === "get") {
      const raw = loadRawConfig();
      const hb = (raw?.heartbeat ?? {}) as Record<string, unknown>;
      const enabled = (hb.enabled as boolean) ?? false;
      const intervalMs = (hb.intervalMs as number) ?? 3_600_000;
      const activeHoursStart = (hb.activeHoursStart as number) ?? null;
      const activeHoursEnd = (hb.activeHoursEnd as number) ?? null;
      const nextRunAt = enabled ? Date.now() + intervalMs : null;
      ctx.send(socket, {
        type: "heartbeat_config_response",
        enabled,
        intervalMs,
        activeHoursStart,
        activeHoursEnd,
        nextRunAt,
        success: true,
      });
    } else if (msg.action === "set") {
      const raw = loadRawConfig();
      const hb = (raw?.heartbeat ?? {}) as Record<string, unknown>;
      if (msg.enabled !== undefined) hb.enabled = msg.enabled;
      if (msg.intervalMs !== undefined) hb.intervalMs = msg.intervalMs;
      if (msg.activeHoursStart !== undefined) {
        hb.activeHoursStart =
          (msg.activeHoursStart === -1 ? undefined : msg.activeHoursStart) ??
          undefined;
      }
      if (msg.activeHoursEnd !== undefined) {
        hb.activeHoursEnd =
          (msg.activeHoursEnd === -1 ? undefined : msg.activeHoursEnd) ??
          undefined;
      }

      const wasSuppressed = ctx.suppressConfigReload;
      ctx.setSuppressConfigReload(true);
      try {
        saveRawConfig({ ...raw, heartbeat: hb });
      } catch (err) {
        ctx.setSuppressConfigReload(wasSuppressed);
        throw err;
      }
      ctx.debounceTimers.schedule(
        "__suppress_reset__",
        () => {
          ctx.setSuppressConfigReload(false);
        },
        CONFIG_RELOAD_DEBOUNCE_MS,
      );

      // Reconfigure the in-memory heartbeat timer so changes take effect immediately
      ctx.heartbeatService?.reconfigure();

      const enabled = (hb.enabled as boolean) ?? false;
      const intervalMs = (hb.intervalMs as number) ?? 3_600_000;
      const nextRunAt = enabled ? Date.now() + intervalMs : null;
      log.info({ enabled, intervalMs }, "Heartbeat config updated");
      ctx.send(socket, {
        type: "heartbeat_config_response",
        enabled,
        intervalMs,
        activeHoursStart: (hb.activeHoursStart as number) ?? null,
        activeHoursEnd: (hb.activeHoursEnd as number) ?? null,
        nextRunAt,
        success: true,
      });
    } else {
      ctx.send(socket, {
        type: "heartbeat_config_response",
        enabled: false,
        intervalMs: 3_600_000,
        activeHoursStart: null,
        activeHoursEnd: null,
        nextRunAt: null,
        success: false,
        error: `Unknown action: ${String(msg.action)}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Heartbeat config handler failed");
    ctx.send(socket, {
      type: "heartbeat_config_response",
      enabled: false,
      intervalMs: 3_600_000,
      activeHoursStart: null,
      activeHoursEnd: null,
      nextRunAt: null,
      success: false,
      error: message,
    });
  }
}

export function handleHeartbeatRunsList(
  msg: HeartbeatRunsList,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const limit = msg.limit ?? 20;
    // Get background conversations and filter to heartbeat-origin only
    const all = conversationStore.listConversations(limit * 20, true);
    const bgConversations = all
      .filter((c) => c.source === "heartbeat")
      .slice(0, limit);

    const runs = bgConversations.map((conv) => {
      // Try to determine result from the last message
      let result = "unknown";
      let summary = "";
      try {
        const messages = conversationStore.getMessages(conv.id);
        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m.role === "assistant");
        if (lastAssistant) {
          const raw = lastAssistant.content;
          // Content may be a plain string or a JSON-stringified array of content blocks
          let fullText = "";
          let lastText = "";
          if (typeof raw === "string") {
            try {
              const blocks = JSON.parse(raw) as Array<{
                type: string;
                text?: string;
              }>;
              if (Array.isArray(blocks)) {
                for (const block of blocks) {
                  if (block.type === "text" && block.text) {
                    fullText += block.text;
                    lastText = block.text;
                  }
                }
              } else {
                fullText = raw;
                lastText = raw;
              }
            } catch {
              fullText = raw;
              lastText = raw;
            }
          }
          if (fullText.includes("HEARTBEAT_OK")) result = "ok";
          else if (fullText.includes("HEARTBEAT_ALERT")) result = "alert";
          // Use only the last text block, stripped of the status marker
          summary = lastText
            .replace(/HEARTBEAT_OK\s*/g, "")
            .replace(/HEARTBEAT_ALERT\s*/g, "")
            .trim();
        }
      } catch {
        // Ignore message read errors
      }
      return {
        id: conv.id,
        title: conv.title ?? "Heartbeat",
        createdAt: conv.createdAt,
        result,
        summary,
      };
    });

    ctx.send(socket, { type: "heartbeat_runs_list_response", runs });
  } catch (err) {
    log.error({ err }, "Heartbeat runs list handler failed");
    ctx.send(socket, { type: "heartbeat_runs_list_response", runs: [] });
  }
}

export function handleHeartbeatRunNow(
  _msg: HeartbeatRunNow,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const heartbeatService = ctx.heartbeatService;
  if (!heartbeatService) {
    ctx.send(socket, {
      type: "heartbeat_run_now_response",
      success: false,
      error: "Heartbeat service not available",
    });
    return;
  }
  heartbeatService
    .runOnce({ force: true })
    .then((didRun) => {
      if (didRun) {
        ctx.send(socket, { type: "heartbeat_run_now_response", success: true });
      } else {
        ctx.send(socket, {
          type: "heartbeat_run_now_response",
          success: false,
          error: "Heartbeat skipped (a previous run is still active)",
        });
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      ctx.send(socket, {
        type: "heartbeat_run_now_response",
        success: false,
        error: message,
      });
    });
}

export function handleHeartbeatChecklistRead(
  _msg: HeartbeatChecklistRead,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const content = readTextFileSync(getWorkspacePromptPath("HEARTBEAT.md"));
    if (content) {
      ctx.send(socket, {
        type: "heartbeat_checklist_response",
        content,
        isDefault: false,
      });
    } else {
      const defaultChecklist = `- Check the current weather and note anything notable
- Review any recent news headlines worth flagging
- Look for calendar events or reminders coming up soon`;
      ctx.send(socket, {
        type: "heartbeat_checklist_response",
        content: defaultChecklist,
        isDefault: true,
      });
    }
  } catch (err) {
    log.error({ err }, "Heartbeat checklist read failed");
    ctx.send(socket, {
      type: "heartbeat_checklist_response",
      content: "",
      isDefault: true,
    });
  }
}

export function handleHeartbeatChecklistWrite(
  msg: HeartbeatChecklistWrite,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const filePath = getWorkspacePromptPath("HEARTBEAT.md");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, msg.content, "utf-8");
    log.info("HEARTBEAT.md updated via settings");
    ctx.send(socket, {
      type: "heartbeat_checklist_write_response",
      success: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Heartbeat checklist write failed");
    ctx.send(socket, {
      type: "heartbeat_checklist_write_response",
      success: false,
      error: message,
    });
  }
}

export const heartbeatHandlers = defineHandlers({
  heartbeat_config: handleHeartbeatConfig,
  heartbeat_runs_list: handleHeartbeatRunsList,
  heartbeat_run_now: handleHeartbeatRunNow,
  heartbeat_checklist_read: handleHeartbeatChecklistRead,
  heartbeat_checklist_write: handleHeartbeatChecklistWrite,
});
