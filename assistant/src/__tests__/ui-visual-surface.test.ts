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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import { validateVisualHtml } from "../tools/ui-surface/visual-validation.js";

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
      "visual (polished inline diagram/chart/explainer — PREFER this when explaining how something works or compares; load the `visualize` skill first)",
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
    expect(result.content).toContain("--color-<moss|stone>-<50-950>");
    expect(result.content).toContain(
      "--color-<forest|emerald|danger|amber>-<100-950>",
    );
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

  test("rejects a bare label whose only same-palette fill is a distant pill", async () => {
    // The fragment that rendered at 1.04:1 in dark mode: two labels painted
    // directly on the transparent background, with the matching light stops
    // used as pill fills several hundred characters away.
    const pill = (palette: string): string =>
      `<span style="background:var(--color-${palette}-100);color:var(--color-${palette}-900);` +
      'border-radius:var(--radius-pill);padding:2px 8px">tag</span>';
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: {
        html:
          '<svg role="img" viewBox="0 0 680 220"><title>Lookup</title><desc>Walk</desc>' +
          '<rect x="40" y="30" width="120" height="44" rx="4" fill="var(--surface-lift)" stroke="var(--border-element)"/>' +
          '<rect x="180" y="30" width="120" height="44" rx="4" fill="var(--surface-lift)" stroke="var(--border-element)"/>' +
          '<rect x="320" y="30" width="120" height="44" rx="4" fill="var(--surface-lift)" stroke="var(--border-element)"/>' +
          '<text x="100" y="52" dominant-baseline="central" font-size="12" fill="var(--content-default)">key</text>' +
          '<text x="240" y="52" dominant-baseline="central" font-size="12" fill="var(--content-default)">hash</text>' +
          '<text x="390" y="70" font-size="12" fill="var(--color-forest-900)">found!</text>' +
          '<text x="470" y="70" font-size="12" fill="var(--color-danger-900)">check next</text></svg>' +
          '<div style="padding:0.5rem 0;font:400 12px var(--font-sans);color:var(--content-secondary)">' +
          "Buckets hold one entry each; a collision walks forward to the next free slot. " +
          "Load factor stays under 0.7 so the walk stays short and lookups stay near constant time. " +
          "The table doubles when it crosses that line, which rehashes every key once.</div>" +
          `<div style="display:flex;gap:12px">${pill("forest")}${pill("danger")}</div>`,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("--color-forest-900");
    expect(result.content).toContain("--color-danger-900");
    expect(result.content).toContain("mirror across their own ramp");
    expect(proxied).toBe(false);
  });

  test("accepts a label painted beside its box in the same group", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: {
        html:
          '<svg role="img" viewBox="0 0 680 120"><title>t</title><desc>d</desc>' +
          '<g><rect x="40" y="30" width="180" height="44" rx="4" fill="var(--color-forest-100)"/>' +
          '<text x="130" y="52" text-anchor="middle" dominant-baseline="central" ' +
          'fill="var(--color-forest-900)">Ingest</text></g></svg>',
      },
    });

    expect(result.isError).toBe(false);
    expect(proxied).toBe(true);
  });

  test("accepts a label whose box fill comes from the group's class rule", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: {
        html:
          '<svg role="img" viewBox="0 0 680 80"><title>t</title><desc>d</desc>' +
          "<style>.bx rect{fill:var(--color-emerald-100);stroke:var(--color-emerald-600)}</style>" +
          '<g class="bx"><rect x="0" y="0" width="200" height="60" rx="4"/>' +
          '<text x="100" y="30" fill="var(--color-emerald-900)">Worker</text></g></svg>',
      },
    });

    expect(result.isError).toBe(false);
    expect(proxied).toBe(true);
  });

  test("rejects dark ramp text with no light fill of the same palette", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: {
        html:
          '<svg role="img" viewBox="0 0 680 80"><title>t</title><desc>d</desc>' +
          "<style>.th{font-size:14px;fill:var(--color-forest-900)}</style>" +
          '<text class="th" x="10" y="40">Gateway</text>' +
          '<text x="10" y="60" fill="var(--color-forest-800)">Routes traffic</text></svg>',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("--color-forest-900");
    expect(result.content).toContain("--color-forest-800");
    expect(result.content).toContain("mirror across their own ramp");
    expect(result.content).toContain("--content-*");
    expect(proxied).toBe(false);
  });

  // Which elements a selector reaches is not knowable from the markup, so a
  // fill anywhere in the fragment pairs a stylesheet-painted label.
  test("accepts stylesheet-painted text once a matched light fill is present", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: {
        html:
          '<svg role="img" viewBox="0 0 680 80"><title>t</title><desc>d</desc>' +
          "<style>.th{font-size:14px;fill:var(--color-forest-900)}</style>" +
          '<rect x="0" y="0" width="200" height="60" fill="var(--color-forest-100)"/>' +
          '<text class="th" x="10" y="30">Gateway</text></svg>',
      },
    });

    expect(result.isError).toBe(false);
    expect(proxied).toBe(true);
  });

  test("accepts a matched triple written in CSS on an HTML card", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: {
        html:
          "<style>.c{background:var(--color-amber-100);border:1px solid var(--color-amber-600);" +
          "color:var(--color-amber-900)}</style>" +
          '<div class="c">Warm path</div>',
      },
    });

    expect(result.isError).toBe(false);
    expect(proxied).toBe(true);
  });

  test("leaves theme-aware content tokens alone", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: {
        html:
          '<svg role="img" viewBox="0 0 680 80"><title>t</title><desc>d</desc>' +
          "<style>.th{font-size:14px;fill:var(--content-strong)}</style>" +
          '<text class="th" x="10" y="40">Gateway</text></svg>',
      },
    });

    expect(result.isError).toBe(false);
    expect(proxied).toBe(true);
  });

  test("rejects light ramp text with no dark fill of the same palette", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: {
        html: '<div style="color:var(--color-stone-100)">Quiet label</div>',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("--color-stone-100");
    expect(result.content).toContain("invisible in light mode");
    expect(proxied).toBe(false);
  });

  test("does not mistake background-color for a text colour", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: {
        html:
          '<div style="background-color:var(--color-danger-900);' +
          'color:var(--content-inset)">Failed</div>',
      },
    });

    expect(result.isError).toBe(false);
    expect(proxied).toBe(true);
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
// Skill reference examples
// ---------------------------------------------------------------------------

describe("the visualize reference examples pass the fragment guards", () => {
  const referencesDir = join(
    import.meta.dir,
    "../config/bundled-skills/visualize/references",
  );

  const examples = readdirSync(referencesDir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .flatMap((file) => {
      const source = readFileSync(join(referencesDir, file), "utf8");
      return [...source.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map(
        (match, index) => ({
          name: `${file} example ${index + 1} (${match[1] || "text"})`,
          body: match[2],
        }),
      );
    });

  test("every fenced example is present", () => {
    expect(examples.length).toBe(20);
  });

  for (const example of examples) {
    test(`${example.name} is accepted verbatim`, () => {
      expect(validateVisualHtml(example.body)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Stringified `data`
// ---------------------------------------------------------------------------

describe("ui_show data double-encoded as a JSON string", () => {
  test("a string that decodes to an object is still accepted", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: JSON.stringify({ html: HTML, height: 320 }),
    });

    expect(result.isError).toBe(false);
    expect(proxied).toBe(true);
  });

  test("a string that fails to decode names the parse failure, not empty html", async () => {
    // The shape the model actually produced: HTML attributes quoted with `"`
    // inside a JSON string, escaped wrong.
    const { result, proxied } = await runUiShow({
      surface_type: "visual",
      data: '{"html": "<div style=\\"color:var(--content-default)\\">Hi</div>"',
    });

    expect(result.isError).toBe(true);
    const content = result.content as string;
    expect(content).toContain(
      "`data` arrived as a JSON-encoded string that could not be parsed",
    );
    expect(content).toContain(
      "Pass `data` as a JSON object rather than a string",
    );
    expect(content).toContain("use single quotes for the HTML attributes");
    expect(content).toContain(
      "Resend the same ui_show with `data` as an object",
    );
    // The misleading cause the model chased for eight minutes in E2E.
    expect(content).not.toContain("non-empty HTML fragment in `data.html`");
    expect(proxied).toBe(false);
  });

  test("the parse error itself is quoted back so the model can locate it", async () => {
    const { result } = await runUiShow({
      surface_type: "visual",
      data: '{"html": "<p>x</p>", }',
    });

    // Whatever the engine's SyntaxError wording, its text is carried through.
    let parseMessage = "";
    try {
      JSON.parse('{"html": "<p>x</p>", }');
    } catch (error) {
      parseMessage = (error as Error).message;
    }
    expect(parseMessage.length).toBeGreaterThan(0);
    expect(result.content).toContain(parseMessage);
  });

  test("dynamic_page gets the same envelope instead of the empty-html hint", async () => {
    const { result, proxied } = await runUiShow({
      surface_type: "dynamic_page",
      data: '{"html": "<section class=\\"a\\">"',
    });

    expect(result.isError).toBe(true);
    const content = result.content as string;
    expect(content).toContain(
      "`data` arrived as a JSON-encoded string that could not be parsed",
    );
    expect(content).not.toContain("requires non-empty HTML in `data.html`");
    expect(proxied).toBe(false);
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
