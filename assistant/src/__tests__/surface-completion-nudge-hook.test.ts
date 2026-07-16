/**
 * Tests for the default `surface-completion-nudge` plugin's hooks.
 *
 * Covers:
 * - The `post-model-call` hook nudges (continue + canonical text appended as a
 *   `user` message) when a turn ends with a progress surface left open: a
 *   `task_progress` card shown and never advanced to a terminal status, and a
 *   `work_result` shown `in_progress`.
 * - It does NOT nudge when the surface was completed via `ui_update`, dismissed
 *   via `ui_dismiss`, or was never a progress surface (a plain card / a form).
 * - Outcomes it does not own are ignored: a provider rejection, a tool-bearing
 *   turn, and a non-main-agent call site.
 * - The signal is scoped to the current response cycle — a surface left open in
 *   a prior cycle (before the last genuine user prompt) does not trigger it.
 * - The one-shot bound is split across the two hooks: `post-model-call` marks it
 *   (nudging at most once per run) and `stop` clears it so the next run nudges
 *   afresh.
 *
 * The loop's actual continuation side-effects live in `agent/loop.ts` and are
 * covered by integration tests. This file isolates the hook.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { INTERNAL_NUDGE_OUTPUT_SUPPRESSION } from "../plugin-api/constants.js";
import type {
  PluginLogger,
  PostModelCallContext,
} from "../plugin-api/types.js";
import postModelCall, {
  SURFACE_COMPLETION_NUDGE_TEXT,
} from "../plugins/defaults/surface-completion-nudge/hooks/post-model-call.js";
import stop from "../plugins/defaults/surface-completion-nudge/hooks/stop.js";
import {
  isSurfaceCompletionNudged,
  resetSurfaceCompletionNudgeStoreForTests,
} from "../plugins/defaults/surface-completion-nudge/nudge-state-store.js";
import type { ContentBlock, Message } from "../providers/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const finalText: ContentBlock = { type: "text", text: "All set." };

let surfaceCounter = 0;

/**
 * An assistant `ui_show` turn paired with its `{ surfaceId }` tool result.
 * Returns both messages plus the assigned surface id.
 */
function showSurface(input: Record<string, unknown>): {
  messages: Message[];
  surfaceId: string;
} {
  surfaceCounter += 1;
  const toolUseId = `tu_show_${surfaceCounter}`;
  const surfaceId = `surface-${surfaceCounter}`;
  return {
    surfaceId,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "ui_show", input }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: JSON.stringify({ surfaceId }),
          },
        ],
      },
    ],
  };
}

function updateSurface(
  surfaceId: string,
  data: Record<string, unknown>,
): Message {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: `tu_update_${surfaceId}`,
        name: "ui_update",
        input: { surface_id: surfaceId, data },
      },
    ],
  };
}

function dismissSurface(surfaceId: string): Message {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: `tu_dismiss_${surfaceId}`,
        name: "ui_dismiss",
        input: { surface_id: surfaceId },
      },
    ],
  };
}

function userPrompt(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

const taskProgressShow = (status?: string): Record<string, unknown> => ({
  surface_type: "card",
  title: "Working on X",
  data: {
    template: "task_progress",
    templateData: {
      title: "Working on X",
      ...(status ? { status } : {}),
      steps: [{ label: "Step 1", status: status ?? "in_progress" }],
    },
  },
});

function makeCtx(
  overrides: Partial<PostModelCallContext> = {},
): PostModelCallContext {
  return {
    conversationId: "conv-scn",
    callSite: "mainAgent",
    content: [finalText],
    messages: [],
    stopReason: null,
    decision: "stop",
    logger: noopLogger,
    broadcast: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  resetSurfaceCompletionNudgeStoreForTests();
  surfaceCounter = 0;
});

// ─── Nudges when a progress surface is left open ──────────────────────────────

describe("surface-completion-nudge — internal-notice suppression", () => {
  test("appends the shared suppression clause inside the notice wrapper", () => {
    expect(SURFACE_COMPLETION_NUDGE_TEXT).toContain(
      INTERNAL_NUDGE_OUTPUT_SUPPRESSION,
    );
    expect(SURFACE_COMPLETION_NUDGE_TEXT.startsWith("<system_notice>")).toBe(
      true,
    );
    expect(SURFACE_COMPLETION_NUDGE_TEXT.endsWith("</system_notice>")).toBe(
      true,
    );
    // The surface-advance + final-reply instruction still leads.
    expect(SURFACE_COMPLETION_NUDGE_TEXT).toContain(
      "Then give your final reply",
    );
  });
});

describe("surface-completion-nudge — nudges on a dangling progress surface", () => {
  test("task_progress card shown and never completed → continue with nudge", async () => {
    const shown = showSurface(taskProgressShow("in_progress"));
    const ctx = makeCtx({
      messages: [userPrompt("do the thing"), ...shown.messages],
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("continue");
    const last = ctx.messages[ctx.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content[0]).toEqual({
      type: "text",
      text: SURFACE_COMPLETION_NUDGE_TEXT,
    });
    expect(isSurfaceCompletionNudged("conv-scn")).toBe(true);
  });

  test("task_progress card shown with no explicit status → continue with nudge", async () => {
    const shown = showSurface(taskProgressShow());
    const ctx = makeCtx({
      messages: [userPrompt("go"), ...shown.messages],
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("continue");
  });

  test("work_result shown in_progress → continue with nudge", async () => {
    const shown = showSurface({
      surface_type: "work_result",
      data: { status: "in_progress", summary: "Crunching" },
    });
    const ctx = makeCtx({
      messages: [userPrompt("go"), ...shown.messages],
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("continue");
  });
});

// ─── Stays quiet when there is nothing to close ───────────────────────────────

describe("surface-completion-nudge — no nudge when surface is closed or absent", () => {
  test("task_progress completed via ui_update → stop", async () => {
    const shown = showSurface(taskProgressShow("in_progress"));
    const ctx = makeCtx({
      messages: [
        userPrompt("go"),
        ...shown.messages,
        updateSurface(shown.surfaceId, {
          templateData: { status: "completed" },
        }),
      ],
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
    expect(isSurfaceCompletionNudged("conv-scn")).toBe(false);
  });

  test("progress surface dismissed via ui_dismiss → stop", async () => {
    const shown = showSurface(taskProgressShow("in_progress"));
    const ctx = makeCtx({
      messages: [
        userPrompt("go"),
        ...shown.messages,
        dismissSurface(shown.surfaceId),
      ],
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
  });

  test("work_result shown completed → stop", async () => {
    const shown = showSurface({
      surface_type: "work_result",
      data: { status: "completed", summary: "Done" },
    });
    const ctx = makeCtx({
      messages: [userPrompt("go"), ...shown.messages],
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
  });

  test("plain card (not a progress surface) → stop", async () => {
    const shown = showSurface({
      surface_type: "card",
      title: "Weather",
      data: { template: "weather_forecast", body: "Sunny" },
    });
    const ctx = makeCtx({
      messages: [userPrompt("go"), ...shown.messages],
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
  });

  test("no surfaces shown at all → stop", async () => {
    const ctx = makeCtx({
      messages: [userPrompt("go")],
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
  });
});

// ─── Outcomes the hook does not own ───────────────────────────────────────────

describe("surface-completion-nudge — ignores outcomes it does not own", () => {
  test("provider rejection (error present) → stop", async () => {
    const shown = showSurface(taskProgressShow("in_progress"));
    const ctx = makeCtx({
      messages: [userPrompt("go"), ...shown.messages],
      error: new Error("provider exploded"),
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
  });

  test("tool-bearing turn (model still working) → stop", async () => {
    const shown = showSurface(taskProgressShow("in_progress"));
    const ctx = makeCtx({
      messages: [userPrompt("go"), ...shown.messages],
      content: [
        { type: "tool_use", id: "tu_next", name: "read_file", input: {} },
      ],
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
  });

  test("non-main-agent call site → stop", async () => {
    const shown = showSurface(taskProgressShow("in_progress"));
    const ctx = makeCtx({
      messages: [userPrompt("go"), ...shown.messages],
      callSite: "heartbeatAgent",
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
  });
});

// ─── Cycle scoping and the one-shot bound ─────────────────────────────────────

describe("surface-completion-nudge — cycle scoping and one-shot bound", () => {
  test("a surface left open in a prior cycle does not trigger this cycle", async () => {
    const priorOpen = showSurface(taskProgressShow("in_progress"));
    const ctx = makeCtx({
      messages: [
        userPrompt("first task"),
        ...priorOpen.messages,
        // New genuine user prompt opens a fresh cycle with no open surface.
        userPrompt("second task"),
      ],
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
  });

  test("nudges at most once per run; stop clears the bound", async () => {
    const shown = showSurface(taskProgressShow("in_progress"));
    const firstCtx = makeCtx({
      messages: [userPrompt("go"), ...shown.messages],
    });

    await postModelCall(firstCtx);
    expect(firstCtx.decision).toBe("continue");

    // Same run, surface still open: the one-shot bound suppresses a second nudge.
    const secondCtx = makeCtx({
      messages: [userPrompt("go"), ...shown.messages],
    });
    await postModelCall(secondCtx);
    expect(secondCtx.decision).toBe("stop");

    // Terminal stop clears the bound so the next run nudges afresh.
    await stop({
      conversationId: "conv-scn",
      messages: [],
      exitReason: "no_tool_calls",
      logger: noopLogger,
      broadcast: () => {},
    });
    expect(isSurfaceCompletionNudged("conv-scn")).toBe(false);

    const thirdCtx = makeCtx({
      messages: [userPrompt("go"), ...shown.messages],
    });
    await postModelCall(thirdCtx);
    expect(thirdCtx.decision).toBe("continue");
  });
});
