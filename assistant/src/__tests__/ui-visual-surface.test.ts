/**
 * Tests for the model-invokable `visual` ui_show surface.
 *
 * Two layers are covered. The tool-level guards (`definitions.ts`) reject a
 * fragment the sandbox would fail silently on — external resources, colour
 * literals, invented `var()` names — before anything is proxied. The daemon
 * resolver then emits the surface: the `ui_surface_show` it sends must
 * validate against the canonical event schema, because the client's stream
 * parser silently drops events that do not.
 */

import { describe, expect, test } from "bun:test";

import { UISurfaceShowEventSchema } from "../api/events/ui-surface-show.js";
import type { AssistantEvent } from "../api/index.js";
import {
  createSurfaceMutex,
  type SurfaceConversationContext,
  surfaceProxyResolver,
} from "../daemon/conversation-surfaces.js";
import type { SurfaceType } from "../daemon/message-protocol.js";
import { INTERACTIVE_SURFACE_TYPES } from "../daemon/message-protocol.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { uiShowTool } from "../tools/ui-surface/definitions.js";

const HTML = '<div style="color:var(--content-default)">Hello</div>';

function makeContext(sent: AssistantEvent[] = []): SurfaceConversationContext {
  return {
    conversationId: "session-1",
    sendToClient: (msg) => sent.push(msg),
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<
      string,
      { actionId: string; data?: Record<string, unknown> }
    >(),
    surfaceState: new Map(),
    surfaceUndoStacks: new Map<string, string[]>(),
    accumulatedSurfaceState: new Map<string, Record<string, unknown>>(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "req-1" }),
    getQueueDepth: () => 0,
    processMessage: async () => "ok",
    withSurface: createSurfaceMutex(),
  };
}

function makeToolContext(onProxy?: () => void): ToolContext {
  return {
    conversationId: "conversation-123",
    workingDir: "/tmp",
    trustClass: "guardian",
    proxyToolResolver: async (): Promise<ToolExecutionResult> => {
      onProxy?.();
      return { content: "Surface displayed", isError: false };
    },
  };
}

/** Run ui_show and report whether the payload reached the proxy. */
async function runUiShow(
  input: Record<string, unknown>,
): Promise<{ result: ToolExecutionResult; proxied: boolean }> {
  let proxied = false;
  const result = await uiShowTool.execute(
    input,
    makeToolContext(() => {
      proxied = true;
    }),
  );
  return { result, proxied };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

describe("ui_show advertises visual", () => {
  test("the surface_type enum includes visual", () => {
    const surfaceTypeEnum = (
      uiShowTool.input_schema as {
        properties: { surface_type: { enum: string[] } };
      }
    ).properties.surface_type.enum;

    expect(surfaceTypeEnum).toContain("visual");
  });

  test("the description points at the visualize skill in one index line", () => {
    expect(uiShowTool.description).toContain(
      "visual (polished custom HTML/SVG visual rendered inline; load the `visualize` skill first and follow it)",
    );
  });

  test("visual is display-only, not an interactive surface", () => {
    expect(INTERACTIVE_SURFACE_TYPES).not.toContain("visual");
  });
});

// ---------------------------------------------------------------------------
// Fragment guards
// ---------------------------------------------------------------------------

describe("ui_show visual fragment guards", () => {
  test("rejects an empty fragment without proxying", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: { html: "   " },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-empty HTML fragment in `data.html`");
    expect(proxied).toBe(false);
  });

  test("rejects an oversized fragment with a simplification hint", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: { html: "<p>x</p>".repeat(8000) },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Simplify");
    expect(result.content).toContain("Fix every item above");
    expect(proxied).toBe(false);
  });

  test("rejects fragments that reach for external resources", async () => {
    for (const bad of [
      '<script src="https://cdn.example.com/chart.js"></script>',
      '<link rel="stylesheet" href="https://cdn.example.com/a.css">',
      '<style>@import url("https://cdn.example.com/a.css");</style>',
    ]) {
      const { result, proxied } = await runUiShow({
        surface_type: "visual",
        data: { html: bad },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("no network access");
      expect(proxied).toBe(false);
    }
  });

  test("rejects hardcoded hex and functional colour literals together", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: {
        html: '<div style="background:#eff6ff;color:#2563eb;border-color:rgba(255, 255, 255, 0.1)">Hi</div>',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("#eff6ff");
    expect(result.content).toContain("#2563eb");
    expect(result.content).toContain("rgba(255, 255, 255, 0.1)");
    expect(proxied).toBe(false);
  });

  test("rejects an invented var() name and enumerates the real vocabulary", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: { html: '<div style="color:var(--color-text-primary)">Hi</div>' },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("--color-text-primary");
    expect(result.content).toContain("--content-default");
    expect(result.content).toContain("--color-<moss|stone|forest|emerald");
    expect(proxied).toBe(false);
  });

  test("does not mistake SVG references, anchors, or entities for colours", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: {
        html:
          '<svg role="img" viewBox="0 0 10 10"><title>t</title>' +
          '<defs><marker id="abc"><path d="M0 0" fill="var(--content-default)"/></marker>' +
          '<linearGradient id="face"><stop stop-color="var(--color-moss-200)"/></linearGradient></defs>' +
          '<line x1="0" y1="0" x2="10" y2="0" marker-end="url(#abc)" stroke="url(#face)"/></svg>' +
          '<a href="#bad">Jump &#8599;</a>',
      },
    });

    expect(result.isError).toBe(false);
    expect(proxied).toBe(true);
  });

  test("accepts custom properties the fragment declares itself", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: {
        html:
          "<style>:root{--gap:8px}.row{gap:var(--gap)}</style>" +
          '<div class="row" style="color:var(--content-default)">Hi</div>',
      },
    });

    expect(result.isError).toBe(false);
    expect(proxied).toBe(true);
  });

  test("accepts a custom property the fragment sets from script", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: {
        html:
          '<div id="grid" style="width:var(--col)">Hi</div>' +
          "<script>document.getElementById('grid').style.setProperty('--col', '120px');</script>",
      },
    });

    expect(result.isError).toBe(false);
    expect(proxied).toBe(true);
  });

  test("validates a fragment the model placed at the top level", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      html: '<div style="color:#fff">Hi</div>',
      data: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("#fff");
    expect(proxied).toBe(false);
  });

  test("the app-substitute guard does not fire for visual", async () => {
    const html =
      '<div id="root" style="color:var(--content-default)"></div><script>' +
      "const data=[/*...*/];".padEnd(2100, "/") +
      "document.getElementById('root').textContent='ok';</script>";
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      title: "Labor Market Stats dashboard",
      data: { html },
    });

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("app-builder");
    expect(proxied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Daemon emission
// ---------------------------------------------------------------------------

describe("ui_show visual emission", () => {
  test("emits a schema-valid inline visual surface and returns its id", async () => {
    const sent: AssistantEvent[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "visual",
      title: "How staging works",
      data: { html: HTML, height: 320 },
    });

    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBeUndefined();

    const show = sent.find((msg) => msg.type === "ui_surface_show");
    expect(show).toBeDefined();
    const parsed = UISurfaceShowEventSchema.parse(show);
    expect(parsed.conversationId).toBe("session-1");
    expect(parsed.surfaceType).toBe("visual");
    expect(parsed.display).toBe("inline");
    expect(parsed.title).toBe("How staging works");
    expect(parsed.data).toEqual({ html: HTML, height: 320 });

    const payload = JSON.parse(result.content) as {
      surfaceId: string;
      note: string;
    };
    expect(payload.surfaceId).toBe(parsed.surfaceId);
    expect(payload.note).toContain("Continue your response in prose");
    expect(payload.note).toContain("ui_dismiss");
    expect(ctx.pendingSurfaceActions.has(parsed.surfaceId)).toBe(false);
  });

  test("lifts a top-level html and height into the surface data", async () => {
    const sent: AssistantEvent[] = [];

    await surfaceProxyResolver(makeContext(sent), "ui_show", {
      surface_type: "visual",
      html: HTML,
      height: 240,
      data: {},
    });

    const parsed = UISurfaceShowEventSchema.parse(
      sent.find((msg) => msg.type === "ui_surface_show"),
    );
    expect(parsed.data).toEqual({ html: HTML, height: 240 });
  });

  test("clamps an out-of-range height estimate", async () => {
    const sent: AssistantEvent[] = [];

    await surfaceProxyResolver(makeContext(sent), "ui_show", {
      surface_type: "visual",
      data: { html: HTML, height: 99999 },
    });

    const parsed = UISurfaceShowEventSchema.parse(
      sent.find((msg) => msg.type === "ui_surface_show"),
    );
    expect(parsed.data.height).toBe(1400);
  });

  test("omits height when the caller supplies none", async () => {
    const sent: AssistantEvent[] = [];

    await surfaceProxyResolver(makeContext(sent), "ui_show", {
      surface_type: "visual",
      data: { html: HTML },
    });

    const parsed = UISurfaceShowEventSchema.parse(
      sent.find((msg) => msg.type === "ui_surface_show"),
    );
    expect(parsed.data).toEqual({ html: HTML });
  });

  test("a pending visual does not hold the one-interactive-surface lock", async () => {
    const sent: AssistantEvent[] = [];
    const ctx = makeContext(sent);
    ctx.pendingSurfaceActions.set("surface-visual", { surfaceType: "visual" });

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "choice",
      data: { options: [{ id: "a", title: "Option A" }] },
    });

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("already awaiting user input");
  });
});
