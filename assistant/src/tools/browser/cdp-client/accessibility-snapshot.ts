/**
 * Pure transformer that converts a raw CDP `Accessibility.getFullAXTree`
 * result into a typed list of interactive snapshot elements plus a
 * `selectorMap` (eid → backendNodeId) for downstream DOM commands.
 *
 * This module is intentionally standalone — no I/O, no CDP calls, no
 * dependency on `cdp-client/types.ts`. That decoupling lets the entire
 * transformer be unit-tested against JSON fixtures without any transport
 * plumbing.
 *
 * The output shape and the `formatAxSnapshot` output are designed to be
 * byte-compatible with the legacy DOM-based snapshot produced by
 * `executeBrowserSnapshot` in `browser-execution.ts`, so the migration in
 * a later PR is a direct drop-in replacement.
 */

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Stable element identifier handed back to the LLM. Matches the `eid`
 * shape the existing DOM-based snapshot produced (`e1`, `e2`, ...) so
 * that prompts referring to "element e5" continue to work after the
 * migration.
 */
export type ElementId = string;

export interface AxSnapshotElement {
  eid: ElementId;
  /** Accessibility role (e.g. "button", "link", "textbox"). */
  role: string;
  /** Accessible name, trimmed and truncated to 80 chars. */
  name: string;
  /** Role-specific value (e.g. input value, checkbox state). */
  value?: string;
  /** Additional attributes surfaced from the AX tree ("placeholder", "checked", "expanded", ...). */
  attrs: Record<string, string>;
  /** Opaque CDP backend node id — used by downstream tools to call DOM commands (click, focus, etc.). */
  backendNodeId: number;
}

export interface AxSnapshotResult {
  elements: AxSnapshotElement[];
  /** Map from `eid` to backendNodeId for O(1) lookup during click/type/etc. */
  selectorMap: Map<ElementId, number>;
}

// ── Constants ─────────────────────────────────────────────────────────

/**
 * Default maximum number of interactive elements returned in a snapshot.
 * Mirrors the legacy `MAX_SNAPSHOT_ELEMENTS` constant in
 * `browser-execution.ts` so parity is preserved during the migration.
 */
export const DEFAULT_MAX_ELEMENTS = 150;

/**
 * AX roles we consider "interactive" and surface to the LLM. Derived
 * from the legacy `INTERACTIVE_SELECTOR` list in `browser-execution.ts`
 * plus standard ARIA interactive roles. A node whose role is in this set
 * is always kept (subject to ignored/backendNodeId filters). Nodes with
 * a `focusable: true` property are also kept regardless of role so that
 * contenteditable widgets and custom controls surface.
 */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "tab",
  "menuitem",
  "option",
  "combobox",
  "listbox",
  "switch",
  "searchbox",
  "slider",
  "spinbutton",
  "treeitem",
]);

/**
 * AX node properties we surface into the element's `attrs` map. Keys not
 * in this set are dropped.
 */
const PROPERTY_ALLOWLIST: ReadonlySet<string> = new Set([
  "placeholder",
  "checked",
  "expanded",
  "selected",
  "pressed",
  "disabled",
  "required",
  "level",
  "url",
]);

// ── Raw AX-tree shapes ────────────────────────────────────────────────
// We only define the subset of fields we actually read. Everything else
// is discarded. These shapes are `unknown`-tolerant on purpose — the
// transformer accepts any JSON-ish input and defensively validates each
// field.

interface RawAxValue {
  type?: string;
  value?: unknown;
}

interface RawAxProperty {
  name?: string;
  value?: RawAxValue;
}

interface RawAxNode {
  nodeId?: string;
  role?: RawAxValue;
  name?: RawAxValue;
  value?: RawAxValue;
  properties?: RawAxProperty[];
  backendDOMNodeId?: number;
  childIds?: string[];
  ignored?: boolean;
}

interface RawAxTree {
  nodes?: RawAxNode[];
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Coerce any AX property value to a string for the `attrs` map. */
function stringifyAxValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // Object/array values are rare here; fall back to JSON for completeness.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Build a tree traversal order over the AX nodes. CDP's
 * `Accessibility.getFullAXTree` returns nodes in a flat array, but
 * element ordering that feels natural to the LLM is document order,
 * which is the result of a depth-first walk from the root(s).
 *
 * Strategy: build a nodeId → node index, then walk from any node that
 * isn't referenced as a child (roots). Nested `RootWebArea` children
 * (iframes) are traversed transparently since they appear as regular
 * children in the flat list.
 *
 * Nodes not reachable from a root are appended at the end in their
 * original order so we never silently lose them in the presence of
 * malformed fixtures.
 */
function walkAxTreeInDocumentOrder(nodes: RawAxNode[]): RawAxNode[] {
  const byId = new Map<string, RawAxNode>();
  const childIds = new Set<string>();
  for (const node of nodes) {
    if (typeof node.nodeId === "string") {
      byId.set(node.nodeId, node);
    }
    if (Array.isArray(node.childIds)) {
      for (const childId of node.childIds) {
        if (typeof childId === "string") childIds.add(childId);
      }
    }
  }

  const roots: RawAxNode[] = [];
  for (const node of nodes) {
    if (typeof node.nodeId === "string" && !childIds.has(node.nodeId)) {
      roots.push(node);
    }
  }

  const ordered: RawAxNode[] = [];
  const visited = new Set<string>();
  const stack: RawAxNode[] = [];

  // Push roots in reverse so pop order matches input order.
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    const root = roots[i];
    if (root) stack.push(root);
  }

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    const id = node.nodeId;
    if (typeof id === "string") {
      if (visited.has(id)) continue;
      visited.add(id);
    }
    ordered.push(node);
    if (Array.isArray(node.childIds)) {
      // Iterate in reverse so the first child is popped next.
      for (let i = node.childIds.length - 1; i >= 0; i -= 1) {
        const childId = node.childIds[i];
        if (typeof childId !== "string") continue;
        const child = byId.get(childId);
        if (child) stack.push(child);
      }
    }
  }

  // Preserve any orphan nodes (not reachable from roots) for determinism.
  for (const node of nodes) {
    const id = node.nodeId;
    if (typeof id === "string" && !visited.has(id)) {
      visited.add(id);
      ordered.push(node);
    } else if (typeof id !== "string") {
      ordered.push(node);
    }
  }

  return ordered;
}

/**
 * Determine whether a node should be included in the snapshot based on
 * its role and `focusable` property. Does NOT check `ignored` or
 * `backendDOMNodeId` — callers handle those earlier.
 */
function isKeeperNode(node: RawAxNode): boolean {
  const role = node.role?.value;
  if (typeof role === "string" && INTERACTIVE_ROLES.has(role)) {
    return true;
  }
  if (Array.isArray(node.properties)) {
    for (const prop of node.properties) {
      if (prop?.name === "focusable" && prop.value?.value === true) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Extract the `attrs` map from an AX node's properties, filtered by the
 * property allowlist.
 */
function extractAttrs(node: RawAxNode): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!Array.isArray(node.properties)) return attrs;
  for (const prop of node.properties) {
    const name = prop?.name;
    if (typeof name !== "string") continue;
    if (!PROPERTY_ALLOWLIST.has(name)) continue;
    attrs[name] = stringifyAxValue(prop.value?.value);
  }
  return attrs;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Transform a raw CDP `Accessibility.getFullAXTree` result into a typed
 * list of interactive elements + a selector map for downstream DOM
 * commands.
 *
 * The input is accepted as `unknown` and defensively validated — garbage
 * input yields an empty result rather than throwing.
 */
export function transformAxTree(
  rawTree: unknown,
  opts?: { maxElements?: number },
): AxSnapshotResult {
  const maxElements = opts?.maxElements ?? DEFAULT_MAX_ELEMENTS;

  const tree = rawTree as RawAxTree | null;
  const rawNodes = tree?.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    return { elements: [], selectorMap: new Map() };
  }

  const orderedNodes = walkAxTreeInDocumentOrder(rawNodes);

  const elements: AxSnapshotElement[] = [];
  const selectorMap = new Map<ElementId, number>();

  for (const node of orderedNodes) {
    if (elements.length >= maxElements) break;

    // Drop ignored nodes (Chrome excluded from the AX tree on purpose).
    if (node.ignored === true) continue;

    // Role and backendNodeId are mandatory for an element to be usable.
    const role = node.role?.value;
    if (typeof role !== "string" || role.length === 0) continue;

    const backendNodeId = node.backendDOMNodeId;
    if (typeof backendNodeId !== "number") continue;

    if (!isKeeperNode(node)) continue;

    const rawName = typeof node.name?.value === "string" ? node.name.value : "";
    const name = rawName.trim().slice(0, 80);

    const rawValue = node.value?.value;
    const value =
      typeof rawValue === "string" && rawValue.length > 0
        ? rawValue
        : undefined;

    const attrs = extractAttrs(node);

    const eid: ElementId = `e${elements.length + 1}`;
    const element: AxSnapshotElement = {
      eid,
      role,
      name,
      attrs,
      backendNodeId,
      ...(value !== undefined ? { value } : {}),
    };
    elements.push(element);
    selectorMap.set(eid, backendNodeId);
  }

  return { elements, selectorMap };
}

/**
 * Render a snapshot result to the same multi-line human-readable output
 * the legacy DOM-based `executeBrowserSnapshot` produced. This format is
 * deliberately byte-compatible with `browser-execution.ts:524-551` so
 * existing prompts, tests, and users keep working after the migration.
 *
 * Output shape:
 *
 *   URL: <url>
 *   Title: <title or "(none)">
 *
 *   [e1] <role attr="val" ...> name
 *   [e2] ...
 *
 *   N interactive element(s) found.
 *
 * When the element list is empty:
 *
 *   URL: <url>
 *   Title: <title or "(none)">
 *
 *   (no interactive elements found)
 */
export function formatAxSnapshot(
  result: AxSnapshotResult,
  page: { url: string; title: string },
): string {
  const lines: string[] = [
    `URL: ${page.url}`,
    `Title: ${page.title || "(none)"}`,
    "",
  ];

  const { elements } = result;
  if (elements.length === 0) {
    lines.push("(no interactive elements found)");
  } else {
    for (const el of elements) {
      let desc = `<${el.role}`;
      for (const [key, val] of Object.entries(el.attrs)) {
        desc += ` ${key}="${val}"`;
      }
      if (el.value !== undefined) {
        desc += ` value="${el.value}"`;
      }
      desc += ">";
      if (el.name) {
        desc += ` ${el.name}`;
      }
      lines.push(`[${el.eid}] ${desc}`);
    }
    lines.push("");
    lines.push(
      `${elements.length} interactive element${
        elements.length === 1 ? "" : "s"
      } found.`,
    );
  }

  return lines.join("\n");
}
