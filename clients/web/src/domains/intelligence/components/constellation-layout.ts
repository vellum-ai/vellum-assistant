export interface CategoryConfig {
  displayName: string;
  color: string;
  emoji: string;
}

const DEFAULT_CATEGORY_CONFIG: CategoryConfig = {
  displayName: "Other",
  color: "#888",
  emoji: "?",
};

export const CATEGORY_CONFIGS: Record<string, CategoryConfig> = {
  email: { displayName: "Email", color: "#A665C9", emoji: "\u{1F4E7}" },
  calendar: { displayName: "Calendar", color: "#0E9B8B", emoji: "\u{1F4C5}" },
  messaging: { displayName: "Messaging", color: "#6B8AE0", emoji: "\u{1F4AC}" },
  browsing: { displayName: "Browsing", color: "#E9642F", emoji: "\u{1F310}" },
  productivity: { displayName: "Productivity", color: "#0E9B8B", emoji: "\u{1F4CB}" },
  development: { displayName: "Development", color: "#EF4400", emoji: "\u{1F528}" },
  voice: { displayName: "Voice", color: "#DB4B77", emoji: "\u{1F3A4}" },
  commerce: { displayName: "Commerce", color: "#E9C91A", emoji: "\u{1F6D2}" },
  content: { displayName: "Content", color: "#DB4B77", emoji: "\u{1F3A8}" },
  health: { displayName: "Health", color: "#4C9B50", emoji: "\u{2764}\u{FE0F}" },
  system: { displayName: "System", color: "#8D99A5", emoji: "\u{2699}\u{FE0F}" },
  integrations: { displayName: "Integrations", color: "#8D99A5", emoji: "\u{1F517}" },
};

export function getCategoryConfig(category: string): CategoryConfig {
  return CATEGORY_CONFIGS[category] ?? DEFAULT_CATEGORY_CONFIG;
}

export const CATEGORY_ORDER: string[] = [
  "email",
  "calendar",
  "messaging",
  "browsing",
  "productivity",
  "development",
  "voice",
  "commerce",
  "content",
  "health",
  "system",
  "integrations",
];

export interface SubCategoryDef {
  label: string;
  emoji: string;
  skillIds: Set<string>;
}

export const SUB_CATEGORY_MAP: Record<string, SubCategoryDef[]> = {
  email: [
    { label: "Sending", emoji: "\u{1F4E8}", skillIds: new Set(["agentmail", "email-setup"]) },
    { label: "Reading", emoji: "\u{1F4EC}", skillIds: new Set(["email-channel", "gmail"]) },
  ],
  messaging: [
    { label: "Chat", emoji: "\u{1F4AC}", skillIds: new Set(["messaging", "slack", "telegram"]) },
    { label: "Notifications", emoji: "\u{1F514}", skillIds: new Set(["notifications"]) },
    { label: "People", emoji: "\u{1F465}", skillIds: new Set(["contacts", "followups"]) },
  ],
  development: [
    { label: "Coding", emoji: "\u{1F4BB}", skillIds: new Set(["typescript-eval", "frontend-design"]) },
    { label: "Dev Tools", emoji: "\u{1F527}", skillIds: new Set(["api-mapping", "cli-discover", "subagent", "app-builder"]) },
  ],
  browsing: [
    { label: "Control", emoji: "\u{1F3AE}", skillIds: new Set(["computer-use", "macos-automation", "browser"]) },
    { label: "Triggers", emoji: "\u{23F0}", skillIds: new Set(["watcher", "time-based-actions"]) },
  ],
  commerce: [
    { label: "Shopping", emoji: "\u{1F6D2}", skillIds: new Set(["amazon", "doordash", "restaurant-reservation"]) },
  ],
  system: [
    { label: "Core", emoji: "\u{1F9E0}", skillIds: new Set(["knowledge-graph", "skills-catalog", "self-upgrade"]) },
    { label: "Daily", emoji: "\u{2600}\u{FE0F}", skillIds: new Set(["start-the-day", "weather"]) },
  ],
};

export interface OrbitItem {
  id: string;
  label: string;
  icon?: string;
  emoji?: string;
  category: string;
  description?: string;
  kind: "skill" | "workspaceFile";
}

export interface CategoryGroup {
  category: string;
  items: OrbitItem[];
}

export type TreeNodeKind =
  | { type: "center" }
  | { type: "category"; category: string }
  | { type: "subCategory"; label: string; emoji: string; category: string }
  | { type: "skill"; item: OrbitItem };

export interface TreeNode {
  id: string;
  kind: TreeNodeKind;
  parentId: string | null;
  depth: number;
  x: number;
  y: number;
  radius: number;
}

/**
 * Minimal positioned-node shape the viewport + fit math depend on. `TreeNode`
 * (skills constellation) and the concept-graph's force-laid-out nodes both
 * satisfy it, so `useConstellationViewport` and {@link computeFit} are reused
 * across both graphs without coupling to either's node model.
 */
export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export interface EdgeLine {
  id: string;
  fromId: string;
  toId: string;
  color: string;
}

export interface Point {
  x: number;
  y: number;
}

export type NodeShape = "circle" | "roundedRect" | "diamond";

export interface NodeShapeDef {
  shape: NodeShape;
  size: number;
  /** Corner radius in pixels (for roundedRect and diamond). Ignored for circle. */
  cornerRadius: number;
}

/** Keep these in sync with the CSS corner radii in ConstellationView.tsx.
 * Clipping uses these to terminate edges at the actual visible shape so there
 * are no visible gaps between lines and rounded node corners. */
const CATEGORY_CORNER_RADIUS = 14;
const SUB_CATEGORY_CORNER_RADIUS = 10;
const SKILL_CORNER_RADIUS = 6;

export function nodeShapeDef(node: TreeNode): NodeShapeDef {
  switch (node.kind.type) {
    case "center":
      return { shape: "circle", size: CENTER_AVATAR_SIZE, cornerRadius: 0 };
    case "category":
      return {
        shape: "roundedRect",
        size: CATEGORY_NODE_SIZE,
        cornerRadius: CATEGORY_CORNER_RADIUS,
      };
    case "subCategory":
      return {
        shape: "roundedRect",
        size: SUB_CATEGORY_NODE_SIZE,
        cornerRadius: SUB_CATEGORY_CORNER_RADIUS,
      };
    case "skill":
      return {
        shape: "diamond",
        size: SKILL_NODE_SIZE,
        cornerRadius: SKILL_CORNER_RADIUS,
      };
  }
}

/** Intersect a ray from the origin with a rounded square of half-side `half`
 * and corner radius `r`. Returns the distance from origin to the boundary. */
function shrinkRoundedRect(
  half: number,
  r: number,
  ux: number,
  uy: number,
): number {
  const rClamped = Math.min(Math.max(0, r), half);
  const absUx = Math.abs(ux);
  const absUy = Math.abs(uy);
  if (absUx < 1e-6 && absUy < 1e-6) return half;

  // First compute where the ray hits the straight (unrounded) square.
  const denom = Math.max(absUx, absUy);
  const tStraight = half / denom;
  const px = tStraight * ux;
  const py = tStraight * uy;

  // If that point lies on a flat edge (not inside the corner zone), that's
  // already the correct intersection.
  const inCornerZone =
    Math.abs(px) > half - rClamped && Math.abs(py) > half - rClamped;
  if (!inCornerZone) return tStraight;

  // Corner zone — intersect with the quarter-circle arc centered at the
  // inset corner. Solve t^2 - 2t*(ux*cx + uy*cy) + (cx^2 + cy^2 - r^2) = 0.
  const cx = Math.sign(px) * (half - rClamped);
  const cy = Math.sign(py) * (half - rClamped);
  const b = ux * cx + uy * cy;
  const c = cx * cx + cy * cy - rClamped * rClamped;
  const disc = b * b - c;
  if (disc < 0) return tStraight;
  return b + Math.sqrt(disc);
}

/** Distance from a node's center to its boundary along a unit direction. */
export function shapeShrink(
  def: NodeShapeDef,
  ux: number,
  uy: number,
): number {
  switch (def.shape) {
    case "circle":
      return def.size / 2;
    case "roundedRect":
      return shrinkRoundedRect(def.size / 2, def.cornerRadius, ux, uy);
    case "diamond": {
      // A diamond is a square rotated 45°. Rotate the input direction by -45°
      // into the unrotated square's frame so we can reuse the rounded-rect
      // intersection math (the corner radius applies before rotation).
      const rotUx = (ux + uy) * Math.SQRT1_2;
      const rotUy = (-ux + uy) * Math.SQRT1_2;
      return shrinkRoundedRect(def.size / 2, def.cornerRadius, rotUx, rotUy);
    }
  }
}

/** Shorten an edge from `from` to `to` so each endpoint lands on the visual
 * boundary of its node instead of the node center. This keeps connector lines
 * from poking through rounded-square corners or ending in the visible gap
 * between a node's straight-rect bounding box and its rounded corners. */
export function clipEdgeToNodes(
  from: TreeNode,
  to: TreeNode,
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) {
    return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  }
  const ux = dx / len;
  const uy = dy / len;
  // Small inset so the line extends a couple pixels into each node's opaque
  // body instead of ending exactly on its boundary. This hides sub-pixel
  // seams (e.g. along the avatar circle, which has no border to visually
  // bridge the gap between the line end and the visible image edge).
  const inset = 3;
  const fromShrink = Math.max(0, shapeShrink(nodeShapeDef(from), ux, uy) - inset);
  const toShrink = Math.max(0, shapeShrink(nodeShapeDef(to), -ux, -uy) - inset);
  // Guard against over-shortening when nodes visually overlap (rare, but can
  // happen if the overlap resolver bottoms out).
  if (fromShrink + toShrink >= len) {
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    return { x1: mx, y1: my, x2: mx, y2: my };
  }
  return {
    x1: from.x + ux * fromShrink,
    y1: from.y + uy * fromShrink,
    x2: to.x - ux * toShrink,
    y2: to.y - uy * toShrink,
  };
}

/** Layout sizes (match macOS ConstellationView). */
export const CATEGORY_NODE_SIZE = 80;
export const SUB_CATEGORY_NODE_SIZE = 56;
export const SKILL_NODE_SIZE = 64;
export const CENTER_AVATAR_SIZE = 90;
const NODE_GAP = 10;
const CENTER_TO_CAT_RADIUS = 200;
const CAT_TO_SUB_CAT_RADIUS = 160;
const SKILL_OUTWARD_DIST = 160;

function resolveOverlap(
  proposed: Point,
  nodeRadius: number,
  existingNodes: TreeNode[],
  gap: number,
): Point {
  let pos: Point = { x: proposed.x, y: proposed.y };
  for (let iter = 0; iter < 30; iter++) {
    let worstOverlap = 0;
    let pushX = 0;
    let pushY = 0;
    for (const existing of existingNodes) {
      const dx = pos.x - existing.x;
      const dy = pos.y - existing.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = nodeRadius + existing.radius + gap;
      const overlap = minDist - dist;
      if (overlap > worstOverlap) {
        worstOverlap = overlap;
        if (dist < 0.1) {
          pushX = overlap + 1;
          pushY = 0;
        } else {
          pushX = (dx / dist) * (overlap + 1);
          pushY = (dy / dist) * (overlap + 1);
        }
      }
    }
    if (worstOverlap <= 0) break;
    pos = { x: pos.x + pushX, y: pos.y + pushY };
  }
  return pos;
}

function placeSkillCluster(
  items: OrbitItem[],
  parentId: string,
  parentPos: Point,
  outwardAngle: number,
  outwardDist: number,
  childSize: number,
  gap: number,
  depth: number,
  category: string,
  edgePrefix: string,
  nodes: TreeNode[],
  edges: EdgeLine[],
): void {
  if (items.length === 0) return;
  const spacing = childSize + gap;
  const outX = Math.cos(outwardAngle);
  const outY = Math.sin(outwardAngle);
  const perpX = -outY;
  const perpY = outX;
  const maxPerRow = 3;
  const rowDepthGap = spacing * 0.88;
  const color = getCategoryConfig(category).color;

  items.forEach((item, idx) => {
    const row = Math.floor(idx / maxPerRow);
    const col = idx % maxPerRow;
    const colsInRow = Math.min(maxPerRow, items.length - row * maxPerRow);
    const perpOffset = (col - (colsInRow - 1) / 2) * spacing;
    const stagger = row % 2 === 1 && colsInRow < maxPerRow ? spacing * 0.5 : 0;
    const outOffset = outwardDist + row * rowDepthGap;
    const proposed: Point = {
      x: parentPos.x + outOffset * outX + (perpOffset + stagger) * perpX,
      y: parentPos.y + outOffset * outY + (perpOffset + stagger) * perpY,
    };
    const pos = resolveOverlap(proposed, childSize / 2, nodes, gap);
    nodes.push({
      id: item.id,
      kind: { type: "skill", item },
      parentId,
      depth,
      x: pos.x,
      y: pos.y,
      radius: childSize / 2,
    });
    edges.push({
      id: `edge-${edgePrefix}-skill-${idx}`,
      fromId: parentId,
      toId: item.id,
      color,
    });
  });
}

export interface BuildTreeResult {
  nodes: TreeNode[];
  edges: EdgeLine[];
}

export function buildTree(
  center: Point,
  groups: CategoryGroup[],
  centerSize = CENTER_AVATAR_SIZE,
): BuildTreeResult {
  const nodes: TreeNode[] = [];
  const edges: EdgeLine[] = [];
  const catSize = CATEGORY_NODE_SIZE;
  const subCatSize = SUB_CATEGORY_NODE_SIZE;
  const skillSize = SKILL_NODE_SIZE;
  const gap = NODE_GAP;

  nodes.push({
    id: "__center__",
    kind: { type: "center" },
    parentId: null,
    depth: 0,
    x: center.x,
    y: center.y,
    radius: centerSize / 2,
  });

  if (groups.length === 0) return { nodes, edges };
  const catCount = groups.length;
  const sectorAngle = (2 * Math.PI) / catCount;

  groups.forEach((group, catIdx) => {
    const catAngle = -Math.PI / 2 + catIdx * sectorAngle;
    const catId = `cat-${group.category}`;
    const catColor = getCategoryConfig(group.category).color;

    const catPos = resolveOverlap(
      {
        x: center.x + CENTER_TO_CAT_RADIUS * Math.cos(catAngle),
        y: center.y + CENTER_TO_CAT_RADIUS * Math.sin(catAngle),
      },
      catSize / 2,
      nodes,
      gap,
    );

    nodes.push({
      id: catId,
      kind: { type: "category", category: group.category },
      parentId: "__center__",
      depth: 1,
      x: catPos.x,
      y: catPos.y,
      radius: catSize / 2,
    });
    edges.push({
      id: `edge-center-${group.category}`,
      fromId: "__center__",
      toId: catId,
      color: catColor,
    });

    const subCats = SUB_CATEGORY_MAP[group.category];
    if (subCats && subCats.length > 0) {
      const subGroupItems: { def: SubCategoryDef; items: OrbitItem[] }[] = [];
      const assignedIds = new Set<string>();

      for (const subCat of subCats) {
        const matching = group.items.filter((it) => subCat.skillIds.has(it.id));
        if (matching.length > 0) {
          subGroupItems.push({ def: subCat, items: matching });
          matching.forEach((m) => assignedIds.add(m.id));
        }
      }

      const unmatched = group.items.filter((it) => !assignedIds.has(it.id));
      if (unmatched.length > 0) {
        if (subGroupItems.length === 0) {
          placeSkillCluster(
            group.items,
            catId,
            catPos,
            catAngle,
            SKILL_OUTWARD_DIST,
            skillSize,
            gap,
            2,
            group.category,
            group.category,
            nodes,
            edges,
          );
          return;
        }
        const last = subGroupItems[subGroupItems.length - 1];
        if (last) last.items.push(...unmatched);
      }

      const subCatCount = subGroupItems.length;
      const maxSubSpread = sectorAngle * 0.55;
      const subSpread =
        subCatCount <= 1 ? 0 : Math.min(maxSubSpread, (subCatCount - 1) * 0.35);

      subGroupItems.forEach((subGroup, subIdx) => {
        let subAngle: number;
        if (subCatCount === 1) {
          subAngle = catAngle;
        } else {
          const t = subIdx / (subCatCount - 1) - 0.5;
          subAngle = catAngle + t * subSpread * 2;
        }
        const subCatId = `subcat-${group.category}-${subIdx}`;
        const subCatPos = resolveOverlap(
          {
            x: catPos.x + CAT_TO_SUB_CAT_RADIUS * Math.cos(subAngle),
            y: catPos.y + CAT_TO_SUB_CAT_RADIUS * Math.sin(subAngle),
          },
          subCatSize / 2,
          nodes,
          gap,
        );
        nodes.push({
          id: subCatId,
          kind: {
            type: "subCategory",
            label: subGroup.def.label,
            emoji: subGroup.def.emoji,
            category: group.category,
          },
          parentId: catId,
          depth: 2,
          x: subCatPos.x,
          y: subCatPos.y,
          radius: subCatSize / 2,
        });
        edges.push({
          id: `edge-${group.category}-sub-${subIdx}`,
          fromId: catId,
          toId: subCatId,
          color: catColor,
        });
        placeSkillCluster(
          subGroup.items,
          subCatId,
          subCatPos,
          subAngle,
          SKILL_OUTWARD_DIST,
          skillSize,
          gap,
          3,
          group.category,
          subCatId,
          nodes,
          edges,
        );
      });
    } else {
      placeSkillCluster(
        group.items,
        catId,
        catPos,
        catAngle,
        SKILL_OUTWARD_DIST,
        skillSize,
        gap,
        2,
        group.category,
        group.category,
        nodes,
        edges,
      );
    }
  });

  return { nodes, edges };
}

export interface BuildGroupsArgs {
  items: OrbitItem[];
}

/** Bucket items into category groups in the canonical display order. */
export function buildGroups(items: OrbitItem[]): CategoryGroup[] {
  const buckets = new Map<string, OrbitItem[]>();
  for (const item of items) {
    const list = buckets.get(item.category);
    if (list) {
      list.push(item);
    } else {
      buckets.set(item.category, [item]);
    }
  }
  const result: CategoryGroup[] = [];
  for (const cat of CATEGORY_ORDER) {
    const list = buckets.get(cat);
    if (list && list.length > 0) {
      result.push({ category: cat, items: list });
    }
  }
  // Include any categories not in CATEGORY_ORDER
  for (const [cat, list] of buckets) {
    if (!CATEGORY_ORDER.includes(cat) && list.length > 0) {
      result.push({ category: cat, items: list });
    }
  }
  return result;
}

export interface FitResult {
  zoom: number;
  panX: number;
  panY: number;
}

/** Compute zoom + pan to fit all nodes in `viewSize` with padding. */
export function computeFit(
  nodes: readonly PositionedNode[],
  center: Point,
  viewWidth: number,
  viewHeight: number,
  padding = 120,
  minZoom = 0.4,
  maxZoom = 3,
): FitResult {
  if (nodes.length === 0) return { zoom: 1, panX: 0, panY: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y);
  }
  const contentWidth = maxX - minX + padding * 2;
  const contentHeight = maxY - minY + padding * 2;
  if (contentWidth <= 0 || contentHeight <= 0 || viewWidth <= 0 || viewHeight <= 0) {
    return { zoom: 1, panX: 0, panY: 0 };
  }
  const fitZoom = Math.min(viewWidth / contentWidth, viewHeight / contentHeight);
  const zoom = Math.max(minZoom, Math.min(maxZoom, fitZoom));
  const contentCenterX = (minX + maxX) / 2 - center.x;
  const contentCenterY = (minY + maxY) / 2 - center.y;
  return {
    zoom,
    panX: -contentCenterX * zoom,
    panY: -contentCenterY * zoom,
  };
}
