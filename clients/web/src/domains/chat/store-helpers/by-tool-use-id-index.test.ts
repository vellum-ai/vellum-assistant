import { describe, expect, it } from "bun:test";

import {
  clearToolUseAnchor,
  setToolUseAnchor,
} from "@/domains/chat/store-helpers/by-tool-use-id-index";

describe("setToolUseAnchor", () => {
  it("sets a new mapping and returns a new Map", () => {
    const index = new Map<string, string>();
    const next = setToolUseAnchor(index, "tu-1", "id-1");

    expect(next).not.toBe(index);
    expect(next.get("tu-1")).toBe("id-1");
    // Source map is left untouched (immutable update).
    expect(index.size).toBe(0);
  });

  it("preserves existing entries when adding a new one", () => {
    const index = new Map([["tu-1", "id-1"]]);
    const next = setToolUseAnchor(index, "tu-2", "id-2");

    expect(next.get("tu-1")).toBe("id-1");
    expect(next.get("tu-2")).toBe("id-2");
  });

  it("returns the same Map reference when toolUseId is undefined", () => {
    const index = new Map([["tu-1", "id-1"]]);
    const next = setToolUseAnchor(index, undefined, "id-1");

    expect(next).toBe(index);
  });

  it("returns the same Map reference when toolUseId is an empty string", () => {
    const index = new Map([["tu-1", "id-1"]]);
    const next = setToolUseAnchor(index, "", "id-1");

    expect(next).toBe(index);
  });

  it("returns the same Map reference when the mapping is unchanged (idempotent)", () => {
    const index = new Map([["tu-1", "id-1"]]);
    const next = setToolUseAnchor(index, "tu-1", "id-1");

    expect(next).toBe(index);
  });

  it("clones when an existing toolUseId is remapped to a different id", () => {
    const index = new Map([["tu-1", "id-1"]]);
    const next = setToolUseAnchor(index, "tu-1", "id-2");

    expect(next).not.toBe(index);
    expect(next.get("tu-1")).toBe("id-2");
    expect(index.get("tu-1")).toBe("id-1");
  });
});

describe("clearToolUseAnchor", () => {
  it("removes an existing mapping and returns a new Map", () => {
    const index = new Map([
      ["tu-1", "id-1"],
      ["tu-2", "id-2"],
    ]);
    const next = clearToolUseAnchor(index, "tu-1");

    expect(next).not.toBe(index);
    expect(next.has("tu-1")).toBe(false);
    expect(next.get("tu-2")).toBe("id-2");
    // Source map is left untouched (immutable update).
    expect(index.has("tu-1")).toBe(true);
  });

  it("returns the same Map reference when toolUseId is undefined", () => {
    const index = new Map([["tu-1", "id-1"]]);
    const next = clearToolUseAnchor(index, undefined);

    expect(next).toBe(index);
  });

  it("returns the same Map reference when toolUseId is not present", () => {
    const index = new Map([["tu-1", "id-1"]]);
    const next = clearToolUseAnchor(index, "tu-missing");

    expect(next).toBe(index);
  });
});
