import {
  getCategoryConfig,
  type OrbitItem,
  type TreeNode,
} from "@/domains/intelligence/components/constellation-layout";

export interface NodeVisibility {
  visible: boolean;
}

/**
 * Builds an opaque color-mix() string composited over the canvas background.
 * Using this instead of a translucent rgba() keeps edge lines from showing
 * through node bodies.
 */
export function mixedBg(color: string, percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  return `color-mix(in oklab, ${color} ${clamped}%, var(--surface-base))`;
}

/** Determines whether a node is visible at the given animation phase. */
export function nodeVisibility(node: TreeNode, phase: 0 | 1 | 2 | 3 | 4): NodeVisibility {
  switch (node.kind.type) {
    case "center":
      return { visible: phase >= 1 };
    case "category":
      return { visible: phase >= 2 };
    case "subCategory":
      return { visible: phase >= 3 };
    case "skill":
      return { visible: phase >= 4 };
  }
}

/** Computes the staggered entry delay for a node based on its type and index. */
export function nodeDelay(node: TreeNode, index: number): number {
  switch (node.kind.type) {
    case "center":
      return 0.05;
    case "category":
      return index * 0.04;
    case "subCategory":
      return index * 0.03;
    case "skill":
      return 0.08 + index * 0.02;
  }
}

/** Maps a tree node to the popover item representation shown on click. */
export function popoverItemForNode(node: TreeNode): OrbitItem | undefined {
  switch (node.kind.type) {
    case "skill":
      return node.kind.item;
    case "category": {
      const cfg = getCategoryConfig(node.kind.category);
      return {
        id: node.id,
        label: cfg.displayName,
        emoji: cfg.emoji,
        category: node.kind.category,
        kind: "workspaceFile" as const,
      };
    }
    case "subCategory":
      return {
        id: node.id,
        label: node.kind.label,
        emoji: node.kind.emoji,
        category: node.kind.category,
        kind: "workspaceFile" as const,
      };
    default:
      return undefined;
  }
}
