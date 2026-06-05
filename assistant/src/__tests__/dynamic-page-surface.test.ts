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
