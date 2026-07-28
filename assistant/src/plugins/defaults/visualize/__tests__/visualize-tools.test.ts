/**
 * Tests for the `default-visualize` plugin's two model-visible tools.
 *
 * Covers the plugin-tool contribution path (bootstrap → registry ownership),
 * the guidance tool's module selection and teaching errors, and the render
 * tool's wire output — the emitted `ui_surface_show` must validate against the
 * canonical event schema, because the client's stream parser silently drops
 * events that do not.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { UISurfaceShowEventSchema } from "../../../../api/events/ui-surface-show.js";
import { bootstrapPlugins } from "../../../../daemon/external-plugins-bootstrap.js";
import {
  __clearRegistryForTesting,
  getPluginToolDefinitions,
  getTool,
  getToolOwner,
  registerPluginTools,
} from "../../../../tools/registry.js";
import type { ToolContext } from "../../../../tools/types.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../../../registry.js";
import type { Plugin } from "../../../types.js";
import { VISUALIZE_GUIDE_MODULES } from "../src/guide-modules.js";
import {
  visualizeGuideTool,
  visualizeRenderTool,
  visualizeTools,
} from "../tools.js";

const TEST_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-visualize-tools-test-${process.pid}`,
);
process.env.VELLUM_WORKSPACE_DIR = TEST_WORKSPACE_DIR;

const PLUGIN_NAME = "default-visualize";

interface SentMessage {
  type: string;
  [key: string]: unknown;
}

function makeContext(overrides: Partial<ToolContext> = {}): {
  context: ToolContext;
  sent: SentMessage[];
} {
  const sent: SentMessage[] = [];
  const context: ToolContext = {
    workingDir: "/tmp",
    conversationId: "conv-visualize-1",
    trustClass: "guardian",
    sendToClient: (msg) => {
      sent.push(msg);
    },
    ...overrides,
  };
  return { context, sent };
}

describe("default-visualize plugin registration", () => {
  beforeEach(async () => {
    resetPluginRegistryForTests();
    __clearRegistryForTesting();
    await rm(TEST_WORKSPACE_DIR, { recursive: true, force: true });
  });

  test("bootstrap contributes both tools, owned by the plugin", async () => {
    await bootstrapPlugins();

    for (const name of ["visualize_guide", "visualize_render"]) {
      expect(getTool(name)).toBeDefined();
      expect(getToolOwner(name)).toEqual({ kind: "plugin", id: PLUGIN_NAME });
    }
  });

  test("the plugin contributes exactly the two visualize tools", () => {
    expect(visualizeTools.map((tool) => tool.name)).toEqual([
      "visualize_guide",
      "visualize_render",
    ]);
  });
});

describe("visualize_guide", () => {
  test("returns the core design system plus the requested module", async () => {
    const { context } = makeContext();
    const result = await visualizeGuideTool.execute(
      { modules: ["diagram"] },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("core design system");
    expect(result.content).toContain("Module: diagram");
    expect(result.content).not.toContain("Module: chart");
  });

  test("serves a distinct document for every module", async () => {
    const { context } = makeContext();
    for (const module of VISUALIZE_GUIDE_MODULES) {
      const result = await visualizeGuideTool.execute(
        { modules: [module] },
        context,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain(`Module: ${module}`);
      expect(result.content.length).toBeGreaterThan(2000);
    }
  });

  test("concatenates several modules in canonical order", async () => {
    const { context } = makeContext();
    const result = await visualizeGuideTool.execute(
      { modules: ["chart", "diagram", "chart"] },
      context,
    );

    expect(result.isError).toBe(false);
    const diagramAt = result.content.indexOf("Module: diagram");
    const chartAt = result.content.indexOf("Module: chart");
    expect(diagramAt).toBeGreaterThan(-1);
    expect(chartAt).toBeGreaterThan(diagramAt);
    // De-duplicated: the repeated module appears once.
    expect(result.content.indexOf("Module: chart", chartAt + 1)).toBe(-1);
  });

  test("rejects an unknown module with the valid set", async () => {
    const { context } = makeContext();
    const result = await visualizeGuideTool.execute(
      { modules: ["animation"] },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("animation");
    expect(result.content).toContain("diagram");
    expect(result.content).toContain("chart");
  });

  test("rejects an empty module list", async () => {
    const { context } = makeContext();
    const result = await visualizeGuideTool.execute({ modules: [] }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("at least one module");
  });
});

describe("visualize_render", () => {
  const html = '<div style="color:var(--content-default)">Hello</div>';

  test("emits a schema-valid inline visual surface and returns its id", async () => {
    const { context, sent } = makeContext();
    const result = await visualizeRenderTool.execute(
      { html, title: "How staging works", height: 320 },
      context,
    );

    expect(result.isError).toBe(false);
    expect(sent).toHaveLength(1);

    const parsed = UISurfaceShowEventSchema.parse(sent[0]);
    expect(parsed.conversationId).toBe("conv-visualize-1");
    expect(parsed.surfaceType).toBe("visual");
    expect(parsed.display).toBe("inline");
    expect(parsed.title).toBe("How staging works");
    expect(parsed.data).toEqual({ html, height: 320 });

    const payload = JSON.parse(result.content) as { surfaceId: string };
    expect(payload.surfaceId).toBe(parsed.surfaceId);
    expect(parsed.surfaceId.length).toBeGreaterThan(0);
  });

  test("omits title and height when not supplied", async () => {
    const { context, sent } = makeContext();
    await visualizeRenderTool.execute({ html }, context);

    const parsed = UISurfaceShowEventSchema.parse(sent[0]);
    expect(parsed.title).toBeUndefined();
    expect(parsed.data).toEqual({ html });
  });

  test("clamps an out-of-range height estimate", async () => {
    const { context, sent } = makeContext();
    await visualizeRenderTool.execute({ html, height: 99999 }, context);

    const parsed = UISurfaceShowEventSchema.parse(sent[0]);
    expect(parsed.data.height).toBe(2000);
  });

  test("rejects empty html without emitting a surface", async () => {
    const { context, sent } = makeContext();
    const result = await visualizeRenderTool.execute({ html: "   " }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-empty html");
    expect(sent).toHaveLength(0);
  });

  test("rejects an oversized fragment with a simplification hint", async () => {
    const { context, sent } = makeContext();
    const result = await visualizeRenderTool.execute(
      { html: "<p>x</p>".repeat(8000) },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Simplify");
    expect(sent).toHaveLength(0);
  });

  test("rejects fragments that reach for external resources", async () => {
    const { context, sent } = makeContext();
    for (const bad of [
      '<script src="https://cdn.example.com/chart.js"></script>',
      '<link rel="stylesheet" href="https://cdn.example.com/a.css">',
      '<style>@import url("https://cdn.example.com/a.css");</style>',
    ]) {
      const result = await visualizeRenderTool.execute({ html: bad }, context);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("no network access");
    }
    expect(sent).toHaveLength(0);
  });

  test("rejects a var() reference to a variable the frame does not inject", async () => {
    const { context, sent } = makeContext();
    const result = await visualizeRenderTool.execute(
      {
        html: '<div style="color:var(--color-text-primary)">Hi</div>',
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("--color-text-primary");
    expect(result.content).toContain("--content-default");
    expect(sent).toHaveLength(0);
  });

  test("accepts a custom property the fragment declares itself", async () => {
    const { context, sent } = makeContext();
    const result = await visualizeRenderTool.execute(
      {
        html:
          "<style>:root{--gap:8px}.row{gap:var(--gap)}</style>" +
          '<div class="row" style="color:var(--content-default)">Hi</div>',
      },
      context,
    );

    expect(result.isError).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("rejects hardcoded hex colours and quotes them back", async () => {
    const { context, sent } = makeContext();
    const result = await visualizeRenderTool.execute(
      {
        html: '<div style="background:#eff6ff;color:#2563eb;border:1px solid #fbbf24">Hi</div>',
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("#eff6ff");
    expect(result.content).toContain("#2563eb");
    expect(result.content).toContain("#fbbf24");
    expect(sent).toHaveLength(0);
  });

  test("rejects functional colour literals", async () => {
    const { context, sent } = makeContext();
    const result = await visualizeRenderTool.execute(
      {
        html: '<div style="background:rgba(255, 255, 255, 0.1)">Hi</div>',
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("rgba(255, 255, 255, 0.1)");
    expect(sent).toHaveLength(0);
  });

  test("reports unknown variables and colour literals in one error", async () => {
    const { context } = makeContext();
    const result = await visualizeRenderTool.execute(
      { html: '<div style="color:var(--text-muted);background:#fff">Hi</div>' },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("--text-muted");
    expect(result.content).toContain("#fff");
  });

  test("does not mistake SVG references, anchors, or entities for colours", async () => {
    const { context, sent } = makeContext();
    const result = await visualizeRenderTool.execute(
      {
        html:
          '<svg role="img" viewBox="0 0 10 10"><title>t</title><desc>d</desc>' +
          '<defs><marker id="abc"><path d="M0 0" fill="var(--content-default)"/></marker>' +
          '<linearGradient id="face"><stop stop-color="var(--color-moss-200)"/></linearGradient></defs>' +
          '<line x1="0" y1="0" x2="10" y2="0" marker-end="url(#abc)" stroke="url(#face)"/></svg>' +
          '<a href="#bad">Jump &#8599;</a>',
      },
      context,
    );

    expect(result.isError).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("degrades gracefully when the client cannot render surfaces", async () => {
    const { context } = makeContext({ sendToClient: undefined });
    const result = await visualizeRenderTool.execute({ html }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Answer in prose instead");
  });

  test("degrades gracefully on a channel without dynamic UI", async () => {
    const { context, sent } = makeContext({ supportsDynamicUi: false });
    const result = await visualizeRenderTool.execute({ html }, context);

    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

describe("disabling the plugin removes its tools", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    __clearRegistryForTesting();
  });

  afterEach(async () => {
    const pluginsDir = join(TEST_WORKSPACE_DIR, "plugins");
    if (existsSync(pluginsDir)) {
      await rm(pluginsDir, { recursive: true, force: true });
    }
  });

  test("the disabled sentinel filters both tools out of the catalog", async () => {
    const plugin: Plugin = {
      manifest: { name: PLUGIN_NAME, version: "1.0.0" },
      tools: visualizeTools,
    };
    registerPlugin(plugin);
    registerPluginTools(PLUGIN_NAME, visualizeTools);

    const visibleNames = () => getPluginToolDefinitions().map((d) => d.name);
    expect(visibleNames()).toContain("visualize_render");

    const sentinelDir = join(TEST_WORKSPACE_DIR, "plugins", PLUGIN_NAME);
    await mkdir(sentinelDir, { recursive: true });
    await writeFile(join(sentinelDir, ".disabled"), "");

    expect(visibleNames()).not.toContain("visualize_guide");
    expect(visibleNames()).not.toContain("visualize_render");
  });
});

test("accepts a custom property the fragment sets from script", async () => {
  const { context, sent } = makeContext();
  const result = await visualizeRenderTool.execute(
    {
      html:
        '<div id="grid" style="width:var(--col)">Hi</div>' +
        "<script>document.getElementById('grid').style.setProperty('--col', '120px');</script>",
    },
    context,
  );

  expect(result.isError).toBe(false);
  expect(sent).toHaveLength(1);
});
