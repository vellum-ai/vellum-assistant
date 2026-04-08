import { describe, expect, it } from "bun:test";

import {
  type AxSnapshotElement,
  type AxSnapshotResult,
  formatAxSnapshot,
  transformAxTree,
} from "../accessibility-snapshot.js";
import nestedFramesFixture from "./fixtures/ax-tree-nested-frames.json" with { type: "json" };
import simpleFixture from "./fixtures/ax-tree-simple.json" with { type: "json" };

// ── transformAxTree ──────────────────────────────────────────────────

describe("transformAxTree", () => {
  it("happy path: simple fixture returns exactly 3 elements with stable eids", () => {
    const result = transformAxTree(simpleFixture);

    expect(result.elements).toHaveLength(3);

    const [e1, e2, e3] = result.elements as [
      AxSnapshotElement,
      AxSnapshotElement,
      AxSnapshotElement,
    ];

    // e1: the button (trimmed + focusable prop not surfaced as attr).
    expect(e1.eid).toBe("e1");
    expect(e1.role).toBe("button");
    expect(e1.name).toBe("Submit Form");
    expect(e1.backendNodeId).toBe(101);
    expect(e1.attrs).toEqual({ disabled: "false" });
    expect(e1.value).toBeUndefined();

    // e2: the link carries its url property in attrs.
    expect(e2.eid).toBe("e2");
    expect(e2.role).toBe("link");
    expect(e2.name).toBe("About Us");
    expect(e2.backendNodeId).toBe(102);
    expect(e2.attrs).toEqual({ url: "https://example.com/about" });

    // e3: the textbox carries placeholder + required + a `value` field.
    expect(e3.eid).toBe("e3");
    expect(e3.role).toBe("textbox");
    expect(e3.name).toBe("Email address");
    expect(e3.backendNodeId).toBe(103);
    expect(e3.value).toBe("user@example.com");
    expect(e3.attrs).toEqual({
      placeholder: "you@example.com",
      required: "true",
    });
  });

  it("filters out ignored nodes", () => {
    const result = transformAxTree(simpleFixture);
    for (const el of result.elements) {
      expect(el.name).not.toBe("Hidden Action");
    }
  });

  it("filters out nodes without backendDOMNodeId", () => {
    const result = transformAxTree(simpleFixture);
    for (const el of result.elements) {
      expect(el.name).not.toBe("Orphan Button");
    }
  });

  it("truncates to opts.maxElements", () => {
    const result = transformAxTree(simpleFixture, { maxElements: 2 });
    expect(result.elements).toHaveLength(2);
    expect(result.elements[0]?.eid).toBe("e1");
    expect(result.elements[1]?.eid).toBe("e2");
    // selectorMap only contains the kept elements.
    expect(result.selectorMap.size).toBe(2);
    expect(result.selectorMap.get("e1")).toBe(101);
    expect(result.selectorMap.get("e2")).toBe(102);
    expect(result.selectorMap.has("e3")).toBe(false);
  });

  it("selectorMap.get() returns the backendNodeId for each eid", () => {
    const result = transformAxTree(simpleFixture);
    expect(result.selectorMap.size).toBe(3);
    expect(result.selectorMap.get("e1")).toBe(101);
    expect(result.selectorMap.get("e2")).toBe(102);
    expect(result.selectorMap.get("e3")).toBe(103);
  });

  it("filters out non-interactive roles (StaticText, generic, RootWebArea)", () => {
    const fixture = {
      nodes: [
        {
          nodeId: "1",
          role: { value: "RootWebArea" },
          name: { value: "Root" },
          backendDOMNodeId: 1,
          childIds: ["2", "3", "4"],
          ignored: false,
        },
        {
          nodeId: "2",
          role: { value: "StaticText" },
          name: { value: "Just some text" },
          backendDOMNodeId: 2,
          childIds: [],
          ignored: false,
        },
        {
          nodeId: "3",
          role: { value: "generic" },
          name: { value: "A div" },
          backendDOMNodeId: 3,
          childIds: [],
          ignored: false,
        },
        {
          nodeId: "4",
          role: { value: "button" },
          name: { value: "Real Button" },
          backendDOMNodeId: 4,
          childIds: [],
          ignored: false,
        },
      ],
    };

    const result = transformAxTree(fixture);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]?.name).toBe("Real Button");
    expect(result.elements[0]?.role).toBe("button");
  });

  it("includes focusable nodes even when the role is not interactive", () => {
    // Regression test for contenteditable divs and custom widgets: a
    // generic-role node with `focusable: true` must still surface.
    const fixture = {
      nodes: [
        {
          nodeId: "1",
          role: { value: "RootWebArea" },
          name: { value: "Root" },
          backendDOMNodeId: 1,
          childIds: ["2"],
          ignored: false,
        },
        {
          nodeId: "2",
          role: { value: "generic" },
          name: { value: "Contenteditable field" },
          properties: [
            { name: "focusable", value: { type: "boolean", value: true } },
          ],
          backendDOMNodeId: 42,
          childIds: [],
          ignored: false,
        },
      ],
    };

    const result = transformAxTree(fixture);
    expect(result.elements).toHaveLength(1);
    const [el] = result.elements;
    expect(el?.role).toBe("generic");
    expect(el?.backendNodeId).toBe(42);
    expect(el?.name).toBe("Contenteditable field");
  });

  it("traverses nested RootWebArea (iframe) children in document order", () => {
    const result = transformAxTree(nestedFramesFixture);

    // Expect 4 kept elements across parent + inner frame, in doc order.
    expect(result.elements).toHaveLength(4);
    expect(result.elements.map((el) => el.name)).toEqual([
      "Parent Button",
      "Inner Link",
      "Inner Search",
      "Subscribe",
    ]);
    expect(result.elements.map((el) => el.backendNodeId)).toEqual([
      201, 203, 204, 205,
    ]);
    expect(result.elements.map((el) => el.eid)).toEqual([
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
  });

  it("truncates names longer than 80 chars", () => {
    const longName = "x".repeat(200);
    const fixture = {
      nodes: [
        {
          nodeId: "1",
          role: { value: "button" },
          name: { value: longName },
          backendDOMNodeId: 1,
          childIds: [],
          ignored: false,
        },
      ],
    };
    const result = transformAxTree(fixture);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]?.name.length).toBe(80);
  });

  it("returns an empty result for malformed input", () => {
    expect(transformAxTree(null)).toEqual({
      elements: [],
      selectorMap: new Map(),
    });
    expect(transformAxTree(undefined)).toEqual({
      elements: [],
      selectorMap: new Map(),
    });
    expect(transformAxTree({})).toEqual({
      elements: [],
      selectorMap: new Map(),
    });
    expect(transformAxTree({ nodes: [] })).toEqual({
      elements: [],
      selectorMap: new Map(),
    });
  });
});

// ── formatAxSnapshot ──────────────────────────────────────────────────

describe("formatAxSnapshot", () => {
  it("byte-matches the legacy executeBrowserSnapshot format for the simple fixture", () => {
    const result = transformAxTree(simpleFixture);
    const formatted = formatAxSnapshot(result, {
      url: "https://example.com/",
      title: "Example",
    });

    const expected = [
      "URL: https://example.com/",
      "Title: Example",
      "",
      `[e1] <button disabled="false"> Submit Form`,
      `[e2] <link url="https://example.com/about"> About Us`,
      `[e3] <textbox placeholder="you@example.com" required="true" value="user@example.com"> Email address`,
      "",
      "3 interactive elements found.",
    ].join("\n");

    expect(formatted).toBe(expected);
  });

  it("uses '(none)' when title is empty", () => {
    const result: AxSnapshotResult = {
      elements: [],
      selectorMap: new Map(),
    };
    const formatted = formatAxSnapshot(result, {
      url: "about:blank",
      title: "",
    });
    expect(formatted).toBe(
      [
        "URL: about:blank",
        "Title: (none)",
        "",
        "(no interactive elements found)",
      ].join("\n"),
    );
  });

  it("renders 'interactive element' (singular) for a single-element result", () => {
    const result: AxSnapshotResult = {
      elements: [
        {
          eid: "e1",
          role: "button",
          name: "Click",
          attrs: {},
          backendNodeId: 1,
        },
      ],
      selectorMap: new Map([["e1", 1]]),
    };
    const formatted = formatAxSnapshot(result, {
      url: "https://example.com/",
      title: "T",
    });
    expect(formatted).toBe(
      [
        "URL: https://example.com/",
        "Title: T",
        "",
        "[e1] <button> Click",
        "",
        "1 interactive element found.",
      ].join("\n"),
    );
  });

  it("omits the trailing ' name' segment when name is empty", () => {
    const result: AxSnapshotResult = {
      elements: [
        {
          eid: "e1",
          role: "button",
          name: "",
          attrs: {},
          backendNodeId: 1,
        },
      ],
      selectorMap: new Map([["e1", 1]]),
    };
    const formatted = formatAxSnapshot(result, {
      url: "https://example.com/",
      title: "T",
    });
    expect(formatted.split("\n")[3]).toBe("[e1] <button>");
  });
});
