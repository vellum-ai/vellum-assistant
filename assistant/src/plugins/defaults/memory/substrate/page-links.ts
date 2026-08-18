// SUBSTRATE (v2+v3).
/**
 * Memory substrate: the single owner of concept-page link syntax.
 *
 * A `links:` frontmatter entry is `"<target-slug> <sep> <why>"` with the
 * separator {@link LINK_SEPARATOR}, split on its first occurrence (no
 * separator: bare slug). An inline `[[wikilink]]` may carry `|display` and/or
 * `#anchor`, neither part of the target. `edges:` entries are bare slugs.
 *
 * Every reader of these shapes imports from here (the v3 edge lane, the
 * pending-buffer hints, the page index, ingest); do not add a second wikilink
 * matcher or `links:` splitter, for the same reason `buffer-format.ts` keeps
 * one buffer-entry matcher.
 *
 * Leaf module: imports nothing from the rest of the substrate.
 */

/** Space, U+2014 EM DASH, space. */
export const LINK_SEPARATOR = ` ${String.fromCodePoint(0x2014)} `;

/** Global; group 1 is the raw inner text. Pair with {@link wikilinkTarget}. */
export const WIKILINK_REGEX = /\[\[([^\]]+)\]\]/g;

export function parseLinkEntry(entry: string): {
  target: string;
  description: string | undefined;
} {
  const sep = entry.indexOf(LINK_SEPARATOR);
  if (sep === -1) {
    return { target: entry.trim(), description: undefined };
  }
  return {
    target: entry.slice(0, sep).trim(),
    description: entry.slice(sep + LINK_SEPARATOR.length).trim() || undefined,
  };
}

/** The slug a wikilink's inner text names; empty for `[[|label]]` / `[[#anchor]]`. */
export function wikilinkTarget(inner: string): string {
  let target = inner;
  const pipe = target.indexOf("|");
  if (pipe !== -1) {
    target = target.slice(0, pipe);
  }
  const hash = target.indexOf("#");
  if (hash !== -1) {
    target = target.slice(0, hash);
  }
  return target.trim();
}

/** Every wikilink target in `text`, in order, empty targets dropped, duplicates kept. */
export function extractWikilinkTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(WIKILINK_REGEX)) {
    const target = wikilinkTarget(match[1]);
    if (target) {
      targets.push(target);
    }
  }
  return targets;
}

export type PageLinkKind = "links" | "wikilink" | "edges";

/** A structural reference from page `from` to slug `to` that has no page behind it. */
export interface DanglingLink {
  from: string;
  to: string;
  kind: PageLinkKind;
}

/** The slice of a `ConceptPage` the finder reads (a parsed page satisfies it). */
export interface PageLinkSource {
  slug: string;
  frontmatter: {
    links?: readonly string[] | undefined;
    edges?: readonly string[] | undefined;
  };
  /** Frontmatter-stripped body. */
  body: string;
}

/**
 * Structural references on `pages` whose target is not in `knownSlugs`.
 * Only slug-shaped targets (`isSlug`, the page store's rule) are references
 * at all: `[[ -f foo ]]` in a shell snippet is not a link to a page. Self
 * references are ignored, each `(from, to, kind)` is reported once, and the
 * result is sorted by `(from, to, kind)` so renderings are byte-stable.
 */
export function findDanglingLinks(
  pages: readonly PageLinkSource[],
  knownSlugs: ReadonlySet<string>,
  isSlug: (target: string) => boolean,
): DanglingLink[] {
  const seen = new Set<string>();
  const dangling: DanglingLink[] = [];
  const report = (from: string, to: string, kind: PageLinkKind): void => {
    if (to === from || knownSlugs.has(to) || !isSlug(to)) {
      return;
    }
    const key = `${kind} ${from} ${to}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    dangling.push({ from, to, kind });
  };

  for (const page of pages) {
    for (const entry of page.frontmatter.links ?? []) {
      report(page.slug, parseLinkEntry(entry).target, "links");
    }
    for (const target of extractWikilinkTargets(page.body)) {
      report(page.slug, target, "wikilink");
    }
    for (const target of page.frontmatter.edges ?? []) {
      report(page.slug, target.trim(), "edges");
    }
  }

  dangling.sort(
    (a, b) =>
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to) ||
      compareStrings(a.kind, b.kind),
  );
  return dangling;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
