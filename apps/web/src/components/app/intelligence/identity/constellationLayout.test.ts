import { describe, expect, test } from "bun:test";

import {
  buildGroups,
  buildTree,
  CATEGORY_NODE_SIZE,
  CATEGORY_ORDER,
  CENTER_AVATAR_SIZE,
  clipEdgeToNodes,
  computeFit,
  type OrbitItem,
  shapeShrink,
  SKILL_NODE_SIZE,
  SUB_CATEGORY_NODE_SIZE,
  type TreeNode,
} from "@/components/app/intelligence/identity/constellationLayout.js";

const CENTER = { x: 600, y: 450 };

function skillItem(id: string, category: OrbitItem["category"]): OrbitItem {
  return {
    id,
    label: id,
    category,
    description: id,
    kind: "skill",
  };
}

describe("buildGroups", () => {
  test("returns an empty list when there are no items", () => {
    expect(buildGroups([])).toEqual([]);
  });

  test("buckets items by category and returns them in canonical order", () => {
    const items: OrbitItem[] = [
      skillItem("x", "knowledge"),
      skillItem("a", "communication"),
      skillItem("b", "communication"),
      skillItem("c", "productivity"),
    ];
    const groups = buildGroups(items);

    expect(groups.map((g) => g.category)).toEqual([
      "communication",
      "productivity",
      "knowledge",
    ]);
    expect(groups[0]?.items).toHaveLength(2);
    expect(groups[1]?.items).toHaveLength(1);
    expect(groups[2]?.items).toHaveLength(1);
  });

  test("preserves the canonical category order even when items arrive reversed", () => {
    const reversed = [...CATEGORY_ORDER].reverse().map((cat, i) =>
      skillItem(`${cat}-${i}`, cat),
    );
    const groups = buildGroups(reversed);
    expect(groups.map((g) => g.category)).toEqual(CATEGORY_ORDER);
  });

  test("drops categories with no matching items", () => {
    const groups = buildGroups([skillItem("only", "media")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.category).toBe("media");
  });
});

describe("buildTree", () => {
  test("returns only the center node for an empty group list", () => {
    const { nodes, edges } = buildTree(CENTER, [], CENTER_AVATAR_SIZE);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.id).toBe("__center__");
    expect(nodes[0]?.kind.type).toBe("center");
    expect(edges).toHaveLength(0);
  });

  test("emits a category node and an edge for each group", () => {
    const items: OrbitItem[] = [
      skillItem("a", "communication"),
      skillItem("b", "productivity"),
    ];
    const groups = buildGroups(items);
    const { nodes, edges } = buildTree(CENTER, groups, CENTER_AVATAR_SIZE);

    const categoryNodes = nodes.filter((n) => n.kind.type === "category");
    expect(categoryNodes).toHaveLength(2);

    // Every category is connected to the center by exactly one edge.
    for (const cat of categoryNodes) {
      const centerEdge = edges.find(
        (e) => e.fromId === "__center__" && e.toId === cat.id,
      );
      expect(centerEdge).toBeDefined();
    }
  });

  test("nests matched skills under their subcategory", () => {
    const groups = buildGroups([
      skillItem("agentmail", "communication"),
      skillItem("phone-calls", "communication"),
    ]);
    const { nodes } = buildTree(CENTER, groups, CENTER_AVATAR_SIZE);

    const subCategoryIds = nodes
      .filter((n) => n.kind.type === "subCategory")
      .map((n) => n.id);
    expect(subCategoryIds.length).toBeGreaterThan(0);

    // Matched skill nodes should have a subcategory as their parent.
    const agentmail = nodes.find((n) => n.id === "agentmail");
    expect(agentmail).toBeDefined();
    expect(subCategoryIds).toContain(agentmail?.parentId ?? "");
  });

  test("places unmatched skills directly under the category when no subcategory is defined", () => {
    // `integration` has no entry in SUB_CATEGORY_MAP, so skills should hang
    // directly off the category node.
    const groups = buildGroups([skillItem("oauth-setup", "integration")]);
    const { nodes } = buildTree(CENTER, groups, CENTER_AVATAR_SIZE);

    const skill = nodes.find((n) => n.id === "oauth-setup");
    expect(skill).toBeDefined();
    expect(skill?.parentId).toBe("cat-integration");
  });

  test("assigns each node a radius matching its kind", () => {
    const groups = buildGroups([
      skillItem("agentmail", "communication"),
    ]);
    const { nodes } = buildTree(CENTER, groups, CENTER_AVATAR_SIZE);

    const center = nodes.find((n) => n.kind.type === "center");
    const category = nodes.find((n) => n.kind.type === "category");
    const subCategory = nodes.find((n) => n.kind.type === "subCategory");
    const skill = nodes.find((n) => n.kind.type === "skill");

    expect(center?.radius).toBe(CENTER_AVATAR_SIZE / 2);
    expect(category?.radius).toBe(CATEGORY_NODE_SIZE / 2);
    expect(subCategory?.radius).toBe(SUB_CATEGORY_NODE_SIZE / 2);
    expect(skill?.radius).toBe(SKILL_NODE_SIZE / 2);
  });

  test("keeps all nodes pairwise non-overlapping after placement", () => {
    // Use a large, mixed input that triggers the overlap-resolution pass.
    const items: OrbitItem[] = [];
    for (const cat of CATEGORY_ORDER) {
      for (let i = 0; i < 4; i++) {
        items.push(skillItem(`${cat}-${i}`, cat));
      }
    }
    const { nodes } = buildTree(CENTER, buildGroups(items), CENTER_AVATAR_SIZE);

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (!a || !b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Allow a small epsilon to account for the finite 30-iteration
        // resolver. In practice 4 skills per category is well under the
        // packing limit.
        expect(dist).toBeGreaterThanOrEqual(a.radius + b.radius - 0.5);
      }
    }
  });
});

describe("computeFit", () => {
  test("returns a neutral transform for an empty node list", () => {
    expect(computeFit([], CENTER, 800, 600)).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  test("clamps zoom to the minimum when the viewport is very small", () => {
    const groups = buildGroups([
      skillItem("a", "communication"),
      skillItem("b", "productivity"),
      skillItem("c", "knowledge"),
    ]);
    const { nodes } = buildTree(CENTER, groups, CENTER_AVATAR_SIZE);
    const fit = computeFit(nodes, CENTER, 40, 40, 120, 0.4, 3);
    expect(fit.zoom).toBe(0.4);
  });

  test("clamps zoom to the maximum when the viewport is very large", () => {
    const groups = buildGroups([skillItem("only", "media")]);
    const { nodes } = buildTree(CENTER, groups, CENTER_AVATAR_SIZE);
    const fit = computeFit(nodes, CENTER, 10000, 10000, 120, 0.4, 3);
    expect(fit.zoom).toBe(3);
  });

  test("centers the content centroid at the viewport center", () => {
    const groups = buildGroups([
      skillItem("a", "communication"),
      skillItem("b", "productivity"),
    ]);
    const { nodes } = buildTree(CENTER, groups, CENTER_AVATAR_SIZE);
    const fit = computeFit(nodes, CENTER, 1200, 900, 120);

    // Derive the content bounding-box center.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }
    const contentOffsetX = (minX + maxX) / 2 - CENTER.x;
    const contentOffsetY = (minY + maxY) / 2 - CENTER.y;

    expect(fit.panX).toBeCloseTo(-contentOffsetX * fit.zoom, 3);
    expect(fit.panY).toBeCloseTo(-contentOffsetY * fit.zoom, 3);
  });
});

describe("shapeShrink", () => {
  test("circles return their half-size regardless of direction", () => {
    const def = { shape: "circle" as const, size: 90, cornerRadius: 0 };
    expect(shapeShrink(def, 1, 0)).toBe(45);
    expect(shapeShrink(def, 0, 1)).toBe(45);
    expect(shapeShrink(def, 0.707, 0.707)).toBe(45);
  });

  test("unrounded rects reach the axis edges at half-size along the axes", () => {
    const def = { shape: "roundedRect" as const, size: 80, cornerRadius: 0 };
    expect(shapeShrink(def, 1, 0)).toBeCloseTo(40);
    expect(shapeShrink(def, 0, 1)).toBeCloseTo(40);
    // Along 45°, a sharp square extends to the corner at halfSize * sqrt(2).
    expect(shapeShrink(def, 0.7071, 0.7071)).toBeCloseTo(40 * Math.SQRT2);
  });

  test("rounded rects pull diagonal rays in to the rounded corner arc", () => {
    // 80x80 with 14px corners. The outer edge of the rounded arc along the
    // +x+y diagonal sits at (half-r) + r/sqrt(2) in each axis, so the
    // radial distance is (half - r) * sqrt(2) + r.
    const def = { shape: "roundedRect" as const, size: 80, cornerRadius: 14 };
    const expected = (40 - 14) * Math.SQRT2 + 14;
    expect(shapeShrink(def, 0.7071, 0.7071)).toBeCloseTo(expected);
  });

  test("diamonds with no corner radius match the rotated-square formula", () => {
    const def = { shape: "diamond" as const, size: 64, cornerRadius: 0 };
    expect(shapeShrink(def, 1, 0)).toBeCloseTo(64 / Math.SQRT2);
    expect(shapeShrink(def, 0.7071, 0.7071)).toBeCloseTo(32);
  });

  test("diamonds with a corner radius shrink the sharp tips", () => {
    const sharp = { shape: "diamond" as const, size: 64, cornerRadius: 0 };
    const rounded = { shape: "diamond" as const, size: 64, cornerRadius: 6 };
    const sharpTip = shapeShrink(sharp, 1, 0);
    const roundedTip = shapeShrink(rounded, 1, 0);
    expect(roundedTip).toBeLessThan(sharpTip);
    // On-diagonal, the edge midpoint is on a flat face — rounding doesn't
    // affect that direction.
    expect(shapeShrink(rounded, 0.7071, 0.7071)).toBeCloseTo(
      shapeShrink(sharp, 0.7071, 0.7071),
    );
  });
});

describe("clipEdgeToNodes", () => {
  function rectNode(id: string, x: number, y: number): TreeNode {
    return {
      id,
      kind: { type: "category", category: "communication" },
      parentId: null,
      depth: 1,
      x,
      y,
      radius: CATEGORY_NODE_SIZE / 2,
    };
  }

  test("shortens endpoints so each end lies near the node boundary", () => {
    const from = rectNode("a", 0, 0);
    const to = rectNode("b", 500, 0);
    const clipped = clipEdgeToNodes(from, to);
    // Axis-aligned rects of size 80 → boundary at 40, minus a small inset
    // so the line reliably extends into the opaque body.
    expect(clipped.x1).toBeGreaterThan(30);
    expect(clipped.x1).toBeLessThanOrEqual(40);
    expect(clipped.x2).toBeGreaterThanOrEqual(460);
    expect(clipped.x2).toBeLessThan(470);
    expect(clipped.y1).toBeCloseTo(0);
    expect(clipped.y2).toBeCloseTo(0);
  });

  test("collapses to a point when nodes overlap", () => {
    const from = rectNode("a", 100, 100);
    const to = rectNode("b", 110, 100);
    const clipped = clipEdgeToNodes(from, to);
    expect(clipped.x1).toBeCloseTo(clipped.x2);
    expect(clipped.y1).toBeCloseTo(clipped.y2);
  });
});
