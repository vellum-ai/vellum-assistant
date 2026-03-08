import { describe, expect, test } from "bun:test";

import type { SkillSummary } from "../skills/catalog.js";
import {
  getImmediateChildren,
  indexCatalogById,
  traverseIncludes,
  validateIncludes,
} from "../skills/include-graph.js";

function makeSkill(id: string, includes?: string[]): SkillSummary {
  return {
    id,
    name: id,
    displayName: id,
    description: `Skill ${id}`,
    directoryPath: `/skills/${id}`,
    skillFilePath: `/skills/${id}/SKILL.md`,
    userInvocable: true,
    disableModelInvocation: false,
    source: "managed",
    includes,
  };
}

describe("indexCatalogById", () => {
  test("creates a map keyed by skill ID", () => {
    const catalog = [makeSkill("a"), makeSkill("b"), makeSkill("c")];
    const index = indexCatalogById(catalog);
    expect(index.size).toBe(3);
    expect(index.get("a")?.id).toBe("a");
    expect(index.get("b")?.id).toBe("b");
    expect(index.get("c")?.id).toBe("c");
  });

  test("empty catalog produces empty map", () => {
    const index = indexCatalogById([]);
    expect(index.size).toBe(0);
  });

  test("last skill wins on duplicate IDs", () => {
    const catalog = [makeSkill("a"), { ...makeSkill("a"), name: "A-override" }];
    const index = indexCatalogById(catalog);
    expect(index.get("a")?.name).toBe("A-override");
  });
});

describe("getImmediateChildren", () => {
  test("returns immediate children that exist in catalog", () => {
    const catalog = [
      makeSkill("parent", ["child-a", "child-b"]),
      makeSkill("child-a"),
      makeSkill("child-b"),
    ];
    const index = indexCatalogById(catalog);
    const children = getImmediateChildren("parent", index);
    expect(children.map((c) => c.id)).toEqual(["child-a", "child-b"]);
  });

  test("skips children not in catalog", () => {
    const catalog = [
      makeSkill("parent", ["child-a", "missing"]),
      makeSkill("child-a"),
    ];
    const index = indexCatalogById(catalog);
    const children = getImmediateChildren("parent", index);
    expect(children.map((c) => c.id)).toEqual(["child-a"]);
  });

  test("returns empty array when parent has no includes", () => {
    const catalog = [makeSkill("parent")];
    const index = indexCatalogById(catalog);
    expect(getImmediateChildren("parent", index)).toEqual([]);
  });

  test("returns empty array when parent has empty includes", () => {
    const catalog = [makeSkill("parent", [])];
    const index = indexCatalogById(catalog);
    expect(getImmediateChildren("parent", index)).toEqual([]);
  });

  test("returns empty array for unknown parent ID", () => {
    const index = indexCatalogById([]);
    expect(getImmediateChildren("unknown", index)).toEqual([]);
  });
});

describe("traverseIncludes", () => {
  test("single skill with no includes returns just itself", () => {
    const catalog = [makeSkill("root")];
    const index = indexCatalogById(catalog);
    const result = traverseIncludes("root", index);
    expect(result.visited).toEqual(["root"]);
  });

  test("parent with immediate children visits all in DFS order", () => {
    const catalog = [
      makeSkill("root", ["child-a", "child-b"]),
      makeSkill("child-a"),
      makeSkill("child-b"),
    ];
    const index = indexCatalogById(catalog);
    const result = traverseIncludes("root", index);
    expect(result.visited).toEqual(["root", "child-a", "child-b"]);
  });

  test("deep nesting traverses recursively", () => {
    const catalog = [
      makeSkill("root", ["mid"]),
      makeSkill("mid", ["leaf"]),
      makeSkill("leaf"),
    ];
    const index = indexCatalogById(catalog);
    const result = traverseIncludes("root", index);
    expect(result.visited).toEqual(["root", "mid", "leaf"]);
  });

  test("diamond dependency visits each node only once", () => {
    const catalog = [
      makeSkill("root", ["a", "b"]),
      makeSkill("a", ["shared"]),
      makeSkill("b", ["shared"]),
      makeSkill("shared"),
    ];
    const index = indexCatalogById(catalog);
    const result = traverseIncludes("root", index);
    expect(result.visited).toEqual(["root", "a", "shared", "b"]);
  });

  test("missing children are silently skipped in happy path", () => {
    const catalog = [
      makeSkill("root", ["exists", "missing"]),
      makeSkill("exists"),
    ];
    const index = indexCatalogById(catalog);
    const result = traverseIncludes("root", index);
    expect(result.visited).toEqual(["root", "exists"]);
  });

  test("unknown root returns just the root ID", () => {
    const index = indexCatalogById([]);
    const result = traverseIncludes("unknown", index);
    expect(result.visited).toEqual(["unknown"]);
  });
});

describe("validateIncludes — missing detection", () => {
  test("valid graph with no missing children returns success", () => {
    const catalog = [makeSkill("root", ["child"]), makeSkill("child")];
    const index = indexCatalogById(catalog);
    const result = validateIncludes("root", index);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visited).toEqual(["root", "child"]);
    }
  });

  test("detects immediate missing child", () => {
    const catalog = [makeSkill("root", ["missing-child"])];
    const index = indexCatalogById(catalog);
    const result = validateIncludes("root", index);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing");
      if (result.error === "missing") {
        expect(result.missingChildId).toBe("missing-child");
        expect(result.parentId).toBe("root");
        expect(result.path).toEqual(["root"]);
      }
    }
  });

  test("detects deeply nested missing child", () => {
    const catalog = [
      makeSkill("root", ["mid"]),
      makeSkill("mid", ["missing-leaf"]),
    ];
    const index = indexCatalogById(catalog);
    const result = validateIncludes("root", index);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing");
      if (result.error === "missing") {
        expect(result.missingChildId).toBe("missing-leaf");
        expect(result.parentId).toBe("mid");
        expect(result.path).toEqual(["root", "mid"]);
      }
    }
  });

  test("first missing child is reported when multiple are missing", () => {
    const catalog = [makeSkill("root", ["missing-a", "missing-b"])];
    const index = indexCatalogById(catalog);
    const result = validateIncludes("root", index);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing");
      if (result.error === "missing") {
        expect(result.missingChildId).toBe("missing-a");
      }
    }
  });

  test("succeeds when skill has no includes", () => {
    const catalog = [makeSkill("root")];
    const index = indexCatalogById(catalog);
    const result = validateIncludes("root", index);
    expect(result.ok).toBe(true);
  });

  test("root skill itself missing still returns success (just the root ID visited)", () => {
    const index = indexCatalogById([]);
    const result = validateIncludes("unknown-root", index);
    // Root doesn't need to be in catalog — it has no includes, so nothing to validate
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visited).toEqual(["unknown-root"]);
    }
  });
});

describe("validateIncludes — cycle detection", () => {
  test("detects direct self-cycle (a -> a)", () => {
    const catalog = [makeSkill("a", ["a"])];
    const index = indexCatalogById(catalog);
    const result = validateIncludes("a", index);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("cycle");
      if (result.error === "cycle") {
        expect(result.cyclePath).toEqual(["a", "a"]);
      }
    }
  });

  test("detects simple two-node cycle (a -> b -> a)", () => {
    const catalog = [makeSkill("a", ["b"]), makeSkill("b", ["a"])];
    const index = indexCatalogById(catalog);
    const result = validateIncludes("a", index);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error === "cycle") {
      expect(result.cyclePath).toEqual(["a", "b", "a"]);
    }
  });

  test("detects indirect cycle (a -> b -> c -> a)", () => {
    const catalog = [
      makeSkill("a", ["b"]),
      makeSkill("b", ["c"]),
      makeSkill("c", ["a"]),
    ];
    const index = indexCatalogById(catalog);
    const result = validateIncludes("a", index);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error === "cycle") {
      expect(result.cyclePath).toEqual(["a", "b", "c", "a"]);
    }
  });

  test("no false positive on diamond dependency", () => {
    const catalog = [
      makeSkill("root", ["a", "b"]),
      makeSkill("a", ["shared"]),
      makeSkill("b", ["shared"]),
      makeSkill("shared"),
    ];
    const index = indexCatalogById(catalog);
    const result = validateIncludes("root", index);
    expect(result.ok).toBe(true);
  });

  test("validates deeply nested chain (4+ levels) without false cycle detection", () => {
    const catalog = [
      makeSkill("l1", ["l2"]),
      makeSkill("l2", ["l3"]),
      makeSkill("l3", ["l4"]),
      makeSkill("l4", ["l5"]),
      makeSkill("l5"),
    ];
    const index = indexCatalogById(catalog);
    const result = validateIncludes("l1", index);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visited).toEqual(["l1", "l2", "l3", "l4", "l5"]);
    }
  });

  test("missing check still works alongside cycle detection", () => {
    const catalog = [
      makeSkill("root", ["exists", "missing"]),
      makeSkill("exists"),
    ];
    const index = indexCatalogById(catalog);
    const result = validateIncludes("root", index);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing");
    }
  });
});
