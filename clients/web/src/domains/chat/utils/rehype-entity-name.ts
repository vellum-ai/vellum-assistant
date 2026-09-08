/**
 * Rehype plugin that marks unique conversation titles and schedule names so
 * they can render as in-app links.
 *
 * The plugin only *proposes*: it rewrites a qualifying text run or whole
 * inline-code span to an `<entity-name>` element carrying the destination,
 * and `ChatMarkdownMessage` maps that tag to `EntityNameLink`. Matching is
 * exact and unique (see `entity-name-links.ts`); an ambiguous or short name
 * is left as the author wrote it.
 *
 * `<pre>` is skipped so a name quoted in a shell transcript or code sample
 * stays literal. `<a>` is skipped so an explicit markdown link is not wrapped
 * again. Inline `<code>` is considered only when the entire span is a name.
 */

import {
  ENTITY_NAME_TAG,
  type EntityNameCatalog,
  type EntityNameEntry,
  findEntityNameMatches,
  lookupEntityName,
} from "@/domains/chat/utils/entity-name-links";
import { REDACTED_CREDENTIAL_TAG } from "@/domains/chat/utils/rehype-redacted-credential";
import { WORKSPACE_PATH_TAG } from "@/domains/chat/utils/workspace-path-links";

type HastText = { type: "text"; value: string };
type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
};
type HastNode = (HastText | HastElement | { type: string }) & {
  children?: HastNode[];
};

const SKIPPED_TAGS = new Set([
  "pre",
  "a",
  "style",
  "script",
  ENTITY_NAME_TAG,
  WORKSPACE_PATH_TAG,
  REDACTED_CREDENTIAL_TAG,
]);

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

function singleTextChild(node: HastElement): string | undefined {
  if (node.children.length !== 1) {
    return undefined;
  }
  const only = node.children[0];
  return only.type === "text" ? (only as HastText).value : undefined;
}

function entityNameElement(entry: EntityNameEntry, text: string): HastElement {
  return {
    type: "element",
    tagName: ENTITY_NAME_TAG,
    properties: { kind: entry.kind, entityId: entry.id, name: text },
    children: [{ type: "text", value: text }],
  };
}

function splitEntityNames(
  value: string,
  catalog: EntityNameCatalog,
): HastNode[] | undefined {
  const hits = findEntityNameMatches(value, catalog);
  if (hits.length === 0) {
    return undefined;
  }
  const parts: HastNode[] = [];
  let lastIndex = 0;
  for (const hit of hits) {
    if (hit.start > lastIndex) {
      parts.push({ type: "text", value: value.slice(lastIndex, hit.start) });
    }
    const entry = catalog.byName.get(hit.name);
    if (entry) {
      parts.push(entityNameElement(entry, hit.name));
    } else {
      parts.push({ type: "text", value: hit.name });
    }
    lastIndex = hit.end;
  }
  if (lastIndex < value.length) {
    parts.push({ type: "text", value: value.slice(lastIndex) });
  }
  return parts;
}

function tryRewriteCode(
  node: HastElement,
  catalog: EntityNameCatalog,
): void {
  const text = singleTextChild(node);
  if (text === undefined) {
    return;
  }
  const entry = lookupEntityName(text, catalog);
  if (!entry) {
    return;
  }
  node.tagName = ENTITY_NAME_TAG;
  node.properties = {
    ...node.properties,
    kind: entry.kind,
    entityId: entry.id,
    name: text,
  };
  node.children = [{ type: "text", value: text }];
}

function walk(node: HastNode, catalog: EntityNameCatalog): void {
  if (isElement(node) && SKIPPED_TAGS.has(node.tagName)) {
    return;
  }
  const children = node.children;
  if (!children) {
    return;
  }
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (isElement(child) && child.tagName === "code") {
      tryRewriteCode(child, catalog);
      continue;
    }
    if (child.type === "text") {
      const replacement = splitEntityNames(
        (child as HastText).value,
        catalog,
      );
      if (replacement) {
        children.splice(i, 1, ...replacement);
      }
      continue;
    }
    walk(child, catalog);
  }
}

export interface RehypeEntityNameOptions {
  catalog: EntityNameCatalog;
}

export function rehypeEntityName(options: RehypeEntityNameOptions) {
  return (tree: HastNode): void => {
    if (options.catalog.names.length === 0) {
      return;
    }
    walk(tree, options.catalog);
  };
}
