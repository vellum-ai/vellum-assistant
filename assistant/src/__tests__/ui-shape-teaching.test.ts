import { describe, expect, test } from "bun:test";

import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { uiShowTool } from "../tools/ui-surface/definitions.js";
import {
  SURFACE_SHAPE_DOCS,
  SURFACE_TYPE_NAMES,
  uiShowTeachingError,
} from "../tools/ui-surface/surface-shape-docs.js";

function makeContext(onProxy?: () => void): ToolContext {
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

// ---------------------------------------------------------------------------
// Schema enum derivation
// ---------------------------------------------------------------------------

describe("surface_type enum derivation", () => {
  test("input_schema enum is derived from SURFACE_SHAPE_DOCS", () => {
    const surfaceTypeEnum = (
      uiShowTool.input_schema as {
        properties: { surface_type: { enum: string[] } };
      }
    ).properties.surface_type.enum;

    expect(surfaceTypeEnum).toEqual(SURFACE_TYPE_NAMES);
    expect(surfaceTypeEnum).toContain("card");
    expect(surfaceTypeEnum).toContain("dynamic_page");
    expect(surfaceTypeEnum.length).toBe(Object.keys(SURFACE_SHAPE_DOCS).length);
  });
});

// ---------------------------------------------------------------------------
// Unknown / missing surface_type
// ---------------------------------------------------------------------------

describe("ui_show unknown surface_type teaching", () => {
  test("missing surface_type returns the type index without proxying", async () => {
    let proxied = false;
    const result = await uiShowTool.execute(
      { data: { title: "Hi" } },
      makeContext(() => {
        proxied = true;
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("`surface_type` is missing");
    expect(result.content).toContain("card (");
    expect(result.content).toContain("channel_setup");
    expect(proxied).toBe(false);
  });

  test("retired types (list, task_preferences) teach instead of proxying", async () => {
    for (const retired of ["list", "task_preferences"]) {
      let proxied = false;
      const result = await uiShowTool.execute(
        { surface_type: retired, data: {} },
        makeContext(() => {
          proxied = true;
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain(`"${retired}" is not a surface type`);
      expect(proxied).toBe(false);
    }
  });

  test("prototype-chain keys are not surface types", async () => {
    let proxied = false;
    const result = await uiShowTool.execute(
      { surface_type: "toString", data: {} },
      makeContext(() => {
        proxied = true;
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"toString" is not a surface type');
    expect(proxied).toBe(false);
  });

  test("unknown surface_type names the bad value and lists valid types", async () => {
    let proxied = false;
    const result = await uiShowTool.execute(
      { surface_type: "banner", data: { title: "Hi" } },
      makeContext(() => {
        proxied = true;
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"banner" is not a surface type');
    expect(result.content).toContain("work_result");
    expect(proxied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Missing essential content per type
// ---------------------------------------------------------------------------

describe("ui_show missing-content teaching", () => {
  const cases: Array<{
    surfaceType: string;
    data: Record<string, unknown>;
    expectInError: string;
  }> = [
    {
      surfaceType: "copy_block",
      data: {},
      expectInError: "{ text, label?, language? }",
    },
    {
      surfaceType: "copy_block",
      data: { text: "   " },
      expectInError: "`data.text`",
    },
    {
      surfaceType: "choice",
      data: { options: [] },
      expectInError: "recommended",
    },
    {
      surfaceType: "table",
      data: { rows: [] },
      expectInError: "`data.columns`",
    },
    { surfaceType: "form", data: {}, expectInError: "`data.fields`" },
    { surfaceType: "confirmation", data: {}, expectInError: "confirmLabel" },
    { surfaceType: "work_result", data: {}, expectInError: "summary" },
    { surfaceType: "oauth_connect", data: {}, expectInError: "providerKey" },
    {
      surfaceType: "channel_setup",
      data: { channel: "email" },
      expectInError: '"slack", "telegram", "phone"',
    },
  ];

  for (const { surfaceType, data, expectInError } of cases) {
    test(`${surfaceType} without essential content returns its shape`, async () => {
      let proxied = false;
      const result = await uiShowTool.execute(
        { surface_type: surfaceType, data },
        makeContext(() => {
          proxied = true;
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain(
        `ui_show ${surfaceType} was not displayed`,
      );
      expect(result.content).toContain(expectInError);
      expect(result.content).toContain(SURFACE_SHAPE_DOCS[surfaceType]!.shape);
      expect(proxied).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Displayable payloads pass through untouched
// ---------------------------------------------------------------------------

describe("ui_show displayable payloads proxy through", () => {
  const cases: Array<{ surfaceType: string; input: Record<string, unknown> }> =
    [
      {
        surfaceType: "choice",
        input: {
          surface_type: "choice",
          data: { options: [{ id: "a", title: "Option A" }] },
        },
      },
      {
        surfaceType:
          "card (lenient — top-level fields are normalized downstream)",
        input: { surface_type: "card", title: "Status", data: {} },
      },
      {
        surfaceType: "file_upload",
        input: { surface_type: "file_upload", data: {} },
      },
      {
        surfaceType: "channel_setup",
        input: { surface_type: "channel_setup", data: { channel: "telegram" } },
      },
    ];

  for (const { surfaceType, input } of cases) {
    test(`${surfaceType} proxies`, async () => {
      let proxied = false;
      const result = await uiShowTool.execute(
        input,
        makeContext(() => {
          proxied = true;
        }),
      );

      expect(result.isError).toBe(false);
      expect(proxied).toBe(true);
    });
  }

  test("empty dynamic_page still gets the bespoke html envelope, not the generic one", async () => {
    const result = await uiShowTool.execute(
      { surface_type: "dynamic_page", data: {} },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires non-empty HTML in `data.html`");
  });
});

// ---------------------------------------------------------------------------
// uiShowTeachingError unit behavior
// ---------------------------------------------------------------------------

describe("uiShowTeachingError", () => {
  test("returns null for a known type with no guard", () => {
    expect(uiShowTeachingError({ surface_type: "card", data: {} })).toBeNull();
  });

  test("treats a non-object data payload as empty", () => {
    const error = uiShowTeachingError({
      surface_type: "confirmation",
      data: "delete it?",
    });
    expect(error).toContain("`data.message`");
  });

  test("every documented type has a purpose and shape", () => {
    for (const name of SURFACE_TYPE_NAMES) {
      expect(SURFACE_SHAPE_DOCS[name]!.purpose.length).toBeGreaterThan(0);
      expect(SURFACE_SHAPE_DOCS[name]!.shape.length).toBeGreaterThan(0);
    }
  });

  test("every documented type appears in the tool description", () => {
    for (const name of SURFACE_TYPE_NAMES) {
      expect(uiShowTool.description).toContain(name);
    }
  });
});
