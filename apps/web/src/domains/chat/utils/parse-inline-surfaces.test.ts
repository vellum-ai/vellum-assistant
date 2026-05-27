import { describe, expect, test } from "bun:test";

import { parseInlineSurfaces } from "./parse-inline-surfaces";

describe("parseInlineSurfaces", () => {
  test("returns null when no <ui_show> tags are present", () => {
    expect(parseInlineSurfaces("Hello, this is plain text.")).toBeNull();
  });

  test("parses a single <ui_show> tag with surrounding text", () => {
    const input =
      'Before text<ui_show surface_type="card" template="task_progress"> {"title":"Test","steps":[{"id":"s1","label":"Step 1","status":"in_progress"}]} </ui_show>After text';

    const result = parseInlineSurfaces(input);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);

    expect(result![0]).toEqual({ type: "text", content: "Before text" });

    const surfaceSegment = result![1];
    expect(surfaceSegment.type).toBe("surface");
    if (surfaceSegment.type === "surface") {
      expect(surfaceSegment.surface.surfaceType).toBe("card");
      expect(surfaceSegment.surface.data.template).toBe("task_progress");
      expect(surfaceSegment.surface.title).toBe("Test");
      const td = surfaceSegment.surface.data.templateData as Record<string, unknown>;
      expect(Array.isArray(td.steps)).toBe(true);
    }

    expect(result![2]).toEqual({ type: "text", content: "After text" });
  });

  test("handles tag at the start of text", () => {
    const input =
      '<ui_show surface_type="card" template="task_progress"> {"title":"T"} </ui_show>trailing';

    const result = parseInlineSurfaces(input);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].type).toBe("surface");
    expect(result![1]).toEqual({ type: "text", content: "trailing" });
  });

  test("handles tag at the end of text", () => {
    const input =
      'leading<ui_show surface_type="card" template="task_progress"> {"title":"T"} </ui_show>';

    const result = parseInlineSurfaces(input);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0]).toEqual({ type: "text", content: "leading" });
    expect(result![1].type).toBe("surface");
  });

  test("handles malformed JSON by emitting the raw tag as text", () => {
    const input =
      'before<ui_show surface_type="card" template="x"> {bad json} </ui_show>after';

    const result = parseInlineSurfaces(input);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    expect(result![0]).toEqual({ type: "text", content: "before" });
    expect(result![1].type).toBe("text");
    expect(result![2]).toEqual({ type: "text", content: "after" });
  });

  test("handles multiple tags", () => {
    const input =
      'a<ui_show surface_type="card" template="t1"> {"title":"First"} </ui_show>b<ui_show surface_type="list" template="t2"> {"title":"Second"} </ui_show>c';

    const result = parseInlineSurfaces(input);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(5);
    expect(result![0]).toEqual({ type: "text", content: "a" });
    expect(result![1].type).toBe("surface");
    expect(result![2]).toEqual({ type: "text", content: "b" });
    expect(result![3].type).toBe("surface");
    expect(result![4]).toEqual({ type: "text", content: "c" });

    if (result![1].type === "surface") {
      expect(result![1].surface.surfaceType).toBe("card");
    }
    if (result![3].type === "surface") {
      expect(result![3].surface.surfaceType).toBe("list");
    }
  });

  test("defaults surfaceType to 'card' when surface_type attr is missing", () => {
    const input = '<ui_show template="task_progress"> {"title":"T"} </ui_show>';

    const result = parseInlineSurfaces(input);
    expect(result).not.toBeNull();
    if (result![0].type === "surface") {
      expect(result![0].surface.surfaceType).toBe("card");
    }
  });

  test("handles tag with no attributes", () => {
    const input = '<ui_show>{"title":"T","steps":[]}</ui_show>';
    const result = parseInlineSurfaces(input);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    if (result![0].type === "surface") {
      expect(result![0].surface.surfaceType).toBe("card");
      expect(result![0].surface.title).toBe("T");
    }
  });

  test("generates unique surfaceIds across calls", () => {
    const input = '<ui_show surface_type="card" template="t"> {"title":"T"} </ui_show>';
    const r1 = parseInlineSurfaces(input);
    const r2 = parseInlineSurfaces(input);
    if (r1![0].type === "surface" && r2![0].type === "surface") {
      expect(r1![0].surface.surfaceId).not.toBe(r2![0].surface.surfaceId);
    }
  });
});
