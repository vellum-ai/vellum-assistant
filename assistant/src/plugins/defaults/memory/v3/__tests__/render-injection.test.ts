import { describe, expect, test } from "bun:test";

import {
  MEMORY_POINTER_LEAD_LINE,
  renderInjectionBlockInner,
  renderPointerInner,
  V3_INJECTION_HEADER,
} from "../render-injection.js";

describe("renderInjectionBlockInner", () => {
  test("prefixes the v2 read-affordance header and joins entries with blank lines", () => {
    const inner = renderInjectionBlockInner([
      "# memory/concepts/page-a.md\nlead a",
      "# memory/concepts/page-b.md § Notes\nnotes b",
    ]);
    expect(inner).toBe(
      `${V3_INJECTION_HEADER}\n\n# memory/concepts/page-a.md\nlead a\n\n# memory/concepts/page-b.md § Notes\nnotes b`,
    );
  });

  test("empty entry list renders the empty string (no header-only block)", () => {
    expect(renderInjectionBlockInner([])).toBe("");
  });

  test("skill entries get a one-shot catalog hint that is not a concept section", () => {
    const inner = renderInjectionBlockInner([
      "# Skill: telegram-setup\nSet up Telegram.",
      "# memory/concepts/page-a.md\nlead a",
    ]);
    expect(inner).toContain(V3_INJECTION_HEADER);
    expect(inner).toContain("# Skills\n");
    expect(inner).toContain("assistant plugins search <name>");
    expect(inner).toContain("assistant skills search <name>");
    expect(inner).toContain("currently in the workspace");
    expect(inner.indexOf("# Skills")).toBeLessThan(inner.indexOf("# Skill:"));
    expect(inner.startsWith(`${V3_INJECTION_HEADER}\n\n# Skills\n`)).toBe(true);
  });

  test("concept-only entries omit the skill catalog hint", () => {
    const inner = renderInjectionBlockInner([
      "# memory/concepts/page-a.md\nlead a",
    ]);
    expect(inner).not.toContain("# Skills\n");
    expect(inner).not.toContain("assistant plugins search");
  });
});

describe("renderPointerInner", () => {
  test("renders the lead line plus one path line per entry, leads as the bare path", () => {
    const inner = renderPointerInner([
      { slug: "page-a", key: "Alpha" },
      { slug: "topics/page-b", key: "" },
      { slug: "page-c", key: "Notes#1" },
    ]);
    expect(inner).toBe(
      [
        MEMORY_POINTER_LEAD_LINE,
        "memory/concepts/page-a.md § Alpha",
        "memory/concepts/topics/page-b.md",
        "memory/concepts/page-c.md § Notes#1",
      ].join("\n"),
    );
  });

  test("empty list renders the empty string", () => {
    expect(renderPointerInner([])).toBe("");
  });
});
