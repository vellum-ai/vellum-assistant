import { describe, expect, test } from "bun:test";

import type {
  DynamicPageSurfaceData,
  UiSurfaceShowDynamicPage,
} from "../daemon/message-protocol.js";
import { INTERACTIVE_SURFACE_TYPES } from "../daemon/message-protocol.js";
import { uiShowTool } from "../tools/ui-surface/definitions.js";

// ---------------------------------------------------------------------------
// DynamicPageSurfaceData shape
// ---------------------------------------------------------------------------

describe("DynamicPageSurfaceData shape", () => {
  test("accepts an object with html, width, and height", () => {
    const data: DynamicPageSurfaceData = {
      html: "<h1>Hi</h1>",
      width: 400,
      height: 300,
    };

    expect(data.html).toBe("<h1>Hi</h1>");
    expect(data.width).toBe(400);
    expect(data.height).toBe(300);
  });

  test("width and height are optional", () => {
    const data: DynamicPageSurfaceData = {
      html: "<p>Hello</p>",
    };

    expect(data.html).toBe("<p>Hello</p>");
    expect(data.width).toBeUndefined();
    expect(data.height).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool definition includes dynamic_page
// ---------------------------------------------------------------------------

describe("Tool definition includes dynamic_page", () => {
  test("input_schema surface_type enum includes dynamic_page", () => {
    const definition = uiShowTool;
    const surfaceTypeEnum = (
      definition.input_schema as {
        properties: { surface_type: { enum: string[] } };
      }
    ).properties.surface_type.enum;

    expect(surfaceTypeEnum).toContain("dynamic_page");
  });

  test("description mentions dynamic_page", () => {
    const definition = uiShowTool;
    expect(definition.description).toContain("dynamic_page");
  });
});

// ---------------------------------------------------------------------------
// Tool execution guard
// ---------------------------------------------------------------------------

describe("ui_show dynamic_page app substitute guard", () => {
  test("rejects dynamic_page when the model labels it as an app build", async () => {
    let proxied = false;

    const result = await uiShowTool.execute(
      {
        surface_type: "dynamic_page",
        title: "JARVIS 1020 Test Counter",
        activity: "Building the JARVIS 1020 Test Counter app",
        data: {
          html: "<button>Increment</button>",
          preview: {
            title: "JARVIS 1020 Test Counter",
            subtitle: "Click INCREMENT to count up",
          },
        },
      },
      {
        conversationId: "conversation-123",
        workingDir: "/tmp",
        trustClass: "guardian",
        proxyToolResolver: async () => {
          proxied = true;
          return { content: "proxied", isError: false };
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('skill: "app-builder"');
    expect(proxied).toBe(false);
  });

  test("rejects dynamic_page with a clean title but substantial interactive html", async () => {
    let proxied = false;

    const result = await uiShowTool.execute(
      {
        surface_type: "dynamic_page",
        title: "Labor Market Stats",
        data: {
          html:
            "<div id='root'></div><script>" +
            "const data=[/*...*/];".padEnd(2100, "/") +
            "new Chart(document.getElementById('root'), {});</script>",
          preview: { title: "Labor Market Stats" },
        },
      },
      {
        conversationId: "conversation-123",
        workingDir: "/tmp",
        trustClass: "guardian",
        proxyToolResolver: async () => {
          proxied = true;
          return { content: "proxied", isError: false };
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('skill: "app-builder"');
    expect(proxied).toBe(false);
  });

  test("rejects dynamic_page with empty data and does not proxy", async () => {
    let proxied = false;

    const result = await uiShowTool.execute(
      {
        surface_type: "dynamic_page",
        title: "SKILL.md — elevenlabs-tts",
        activity: "Reopening SKILL.md with rendered content",
        data: {},
      },
      {
        conversationId: "conversation-123",
        workingDir: "/tmp",
        trustClass: "guardian",
        proxyToolResolver: async () => {
          proxied = true;
          return { content: "proxied", isError: false };
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("data.html");
    expect(proxied).toBe(false);
  });

  test("rejects dynamic_page with whitespace-only html and does not proxy", async () => {
    let proxied = false;

    const result = await uiShowTool.execute(
      {
        surface_type: "dynamic_page",
        title: "Blank",
        data: { html: "   \n  " },
      },
      {
        conversationId: "conversation-123",
        workingDir: "/tmp",
        trustClass: "guardian",
        proxyToolResolver: async () => {
          proxied = true;
          return { content: "proxied", isError: false };
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(proxied).toBe(false);
  });

  test("allows transient non-app dynamic_page surfaces", async () => {
    let proxied = false;

    const result = await uiShowTool.execute(
      {
        surface_type: "dynamic_page",
        title: "My Slides",
        data: {
          html: "<h1>Hello</h1>",
          preview: {
            title: "Slides",
            subtitle: "3 slides about Apple",
          },
        },
      },
      {
        conversationId: "conversation-123",
        workingDir: "/tmp",
        trustClass: "guardian",
        proxyToolResolver: async () => {
          proxied = true;
          return { content: "proxied", isError: false };
        },
      },
    );

    expect(result).toEqual({ content: "proxied", isError: false });
    expect(proxied).toBe(true);
  });
});

describe("ui_show empty card guard", () => {
  function makeCtx(onProxy: () => void) {
    return {
      conversationId: "conversation-123",
      workingDir: "/tmp",
      trustClass: "guardian" as const,
      proxyToolResolver: async () => {
        onProxy();
        return { content: "proxied", isError: false };
      },
    };
  }

  test("rejects a card carrying only a title and does not proxy", async () => {
    let proxied = false;
    const result = await uiShowTool.execute(
      {
        surface_type: "card",
        title: "Vellum Internal Usage app",
        activity: "Showing progress",
        data: {},
      },
      makeCtx(() => {
        proxied = true;
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("card requires content");
    expect(proxied).toBe(false);
  });

  test("rejects a card with no content at all", async () => {
    let proxied = false;
    const result = await uiShowTool.execute(
      { surface_type: "card", data: {} },
      makeCtx(() => {
        proxied = true;
      }),
    );

    expect(result.isError).toBe(true);
    expect(proxied).toBe(false);
  });

  test("allows a card with a body", async () => {
    let proxied = false;
    const result = await uiShowTool.execute(
      { surface_type: "card", data: { title: "Plain", body: "hi" } },
      makeCtx(() => {
        proxied = true;
      }),
    );

    expect(result.isError).toBe(false);
    expect(proxied).toBe(true);
  });

  test("allows a task_progress card with empty data (template renders a shell)", async () => {
    let proxied = false;
    const result = await uiShowTool.execute(
      {
        surface_type: "card",
        template: "task_progress",
        templateData: { status: "in_progress", steps: [] },
      },
      makeCtx(() => {
        proxied = true;
      }),
    );

    expect(result.isError).toBe(false);
    expect(proxied).toBe(true);
  });

  test("allows an action-only card", async () => {
    let proxied = false;
    const result = await uiShowTool.execute(
      {
        surface_type: "card",
        title: "Confirm",
        actions: [{ id: "ok", label: "OK" }],
        data: {},
      },
      makeCtx(() => {
        proxied = true;
      }),
    );

    expect(result.isError).toBe(false);
    expect(proxied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// task_progress ui_show appends the update hint to its return value
// ---------------------------------------------------------------------------

describe("ui_show task_progress update hint", () => {
  const ctx = {
    conversationId: "conversation-123",
    workingDir: "/tmp",
    trustClass: "guardian" as const,
    proxyToolResolver: async () => ({
      content: "Surface displayed (surface_id: surf-1).",
      isError: false,
    }),
  };

  test("appends the ui_update hint after a task_progress card is shown", async () => {
    const result = await uiShowTool.execute(
      {
        surface_type: "card",
        template: "task_progress",
        templateData: { status: "in_progress", steps: [] },
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Surface displayed (surface_id: surf-1).");
    expect(result.content).toContain("call ui_update with this surface_id");
  });

  test("recognizes task_progress nested under data", async () => {
    const result = await uiShowTool.execute(
      {
        surface_type: "card",
        data: {
          template: "task_progress",
          templateData: { status: "in_progress" },
        },
      },
      ctx,
    );

    expect(result.content).toContain("call ui_update with this surface_id");
  });

  test("does not append the hint for a non-task_progress card", async () => {
    const result = await uiShowTool.execute(
      { surface_type: "card", data: { title: "Plain", body: "hi" } },
      ctx,
    );

    expect(result.content).toBe("Surface displayed (surface_id: surf-1).");
  });

  test("does not append the hint when the surface call errors", async () => {
    const result = await uiShowTool.execute(
      {
        surface_type: "card",
        template: "task_progress",
        templateData: { status: "in_progress" },
      },
      {
        ...ctx,
        proxyToolResolver: async () => ({
          content: "blocked on this channel",
          isError: true,
        }),
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("blocked on this channel");
  });
});

// ---------------------------------------------------------------------------
// UiSurfaceShowDynamicPage structure
// ---------------------------------------------------------------------------

describe("UiSurfaceShowDynamicPage structure", () => {
  test("can construct a well-typed UiSurfaceShowDynamicPage object", () => {
    const msg: UiSurfaceShowDynamicPage = {
      type: "ui_surface_show",
      conversationId: "session-abc",
      surfaceId: "surface-123",
      surfaceType: "dynamic_page",
      data: { html: "<div>Content</div>" },
    };

    expect(msg.type).toBe("ui_surface_show");
    expect(msg.surfaceType).toBe("dynamic_page");
    expect(typeof msg.data.html).toBe("string");
    expect(msg.conversationId).toBe("session-abc");
    expect(msg.surfaceId).toBe("surface-123");
  });
});

// ---------------------------------------------------------------------------
// Interactivity
// ---------------------------------------------------------------------------

describe("dynamic_page interactivity", () => {
  test("dynamic_page is in the interactive surface types list", () => {
    expect(INTERACTIVE_SURFACE_TYPES).toContain("dynamic_page");
  });
});
