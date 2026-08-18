/**
 * Tests for `substrate/page-links.ts`: the single owner of `links:` entry and
 * `[[wikilink]]` parsing, plus the dangling-link finder every write-side
 * report uses.
 */

import { describe, expect, test } from "bun:test";

import {
  extractWikilinkTargets,
  findDanglingLinks,
  LINK_SEPARATOR,
  parseLinkEntry,
  WIKILINK_REGEX,
  wikilinkTarget,
} from "../page-links.js";
import { isValidSlug } from "../page-store.js";

/** Build a `"<slug> <sep> <why>"` links entry without spelling the separator. */
const link = (target: string, why?: string): string =>
  why === undefined ? target : `${target}${LINK_SEPARATOR}${why}`;

describe("LINK_SEPARATOR", () => {
  test("is space, U+2014 EM DASH, space", () => {
    expect(LINK_SEPARATOR).toHaveLength(3);
    expect(LINK_SEPARATOR.codePointAt(1)).toBe(0x2014);
    expect(LINK_SEPARATOR[0]).toBe(" ");
    expect(LINK_SEPARATOR[2]).toBe(" ");
  });
});

describe("parseLinkEntry", () => {
  test("splits target and description on the first separator", () => {
    expect(parseLinkEntry(link("alice", "the principal"))).toEqual({
      target: "alice",
      description: "the principal",
    });
  });

  test("keeps later separators inside the description", () => {
    const why = `why${LINK_SEPARATOR}with a second dash`;
    expect(parseLinkEntry(link("alice", why))).toEqual({
      target: "alice",
      description: why,
    });
  });

  test("a bare slug carries no description; whitespace is trimmed", () => {
    expect(parseLinkEntry("  alice  ")).toEqual({
      target: "alice",
      description: undefined,
    });
  });

  test("an empty annotation after the separator reads as no description", () => {
    expect(parseLinkEntry(`alice${LINK_SEPARATOR}  `)).toEqual({
      target: "alice",
      description: undefined,
    });
  });
});

describe("wikilinkTarget / extractWikilinkTargets", () => {
  test("strips |display and #anchor suffixes and trims", () => {
    expect(wikilinkTarget("alice")).toBe("alice");
    expect(wikilinkTarget("alice|Alice B.")).toBe("alice");
    expect(wikilinkTarget("alice#role")).toBe("alice");
    expect(wikilinkTarget(" tools/vs-code#setup|editor ")).toBe(
      "tools/vs-code",
    );
    expect(wikilinkTarget("|label")).toBe("");
    expect(wikilinkTarget("#anchor")).toBe("");
  });

  test("extracts every target in order, dropping empty ones, keeping duplicates", () => {
    const body =
      "See [[alice]] and [[bob|Bob]] then [[alice#role]] but not [[|x]] or [[#y]].";
    expect(extractWikilinkTargets(body)).toEqual(["alice", "bob", "alice"]);
  });

  test("the regex is global and captures the raw inner text", () => {
    const matches = [..."[[a|A]] [[b#c]]".matchAll(WIKILINK_REGEX)].map(
      (m) => m[1],
    );
    expect(matches).toEqual(["a|A", "b#c"]);
  });
});

describe("findDanglingLinks", () => {
  const known = new Set(["alice", "bob", "hub", "skills/deploy"]);

  test("reports links:, wikilink, and edges: targets absent from the known set", () => {
    const result = findDanglingLinks(
      [
        {
          slug: "hub",
          frontmatter: {
            links: [link("alice", "principal"), link("atl-1291", "ticket")],
            edges: ["bob", "ghost-edge"],
          },
          body: "Lead mentions [[alice]] and [[ghost-wiki|Ghost]].",
        },
      ],
      known,
      isValidSlug,
    );
    expect(result).toEqual([
      { from: "hub", to: "atl-1291", kind: "links" },
      { from: "hub", to: "ghost-edge", kind: "edges" },
      { from: "hub", to: "ghost-wiki", kind: "wikilink" },
    ]);
  });

  test("resolves against synthetic slugs too when the caller counts them as known", () => {
    expect(
      findDanglingLinks(
        [
          {
            slug: "alice",
            frontmatter: { links: [link("skills/deploy")] },
            body: "",
          },
        ],
        known,
        isValidSlug,
      ),
    ).toEqual([]);
  });

  test("ignores self-references and empty targets, dedupes per (from, to, kind)", () => {
    const result = findDanglingLinks(
      [
        {
          slug: "alice",
          frontmatter: {
            links: [
              link("alice", "self"),
              link("ghost"),
              link("ghost", "twice"),
            ],
          },
          body: "[[alice]] [[ghost]] [[ghost#sec]] [[|nothing]]",
        },
      ],
      known,
      isValidSlug,
    );
    expect(result).toEqual([
      { from: "alice", to: "ghost", kind: "links" },
      { from: "alice", to: "ghost", kind: "wikilink" },
    ]);
  });

  test("output is sorted by (from, to, kind) regardless of page order", () => {
    const pages = [
      { slug: "zed", frontmatter: { links: [link("nope")] }, body: "[[nope]]" },
      { slug: "amy", frontmatter: {}, body: "[[zzz]] [[aaa]]" },
    ];
    const forward = findDanglingLinks(pages, known, isValidSlug);
    const reversed = findDanglingLinks(
      [...pages].reverse(),
      known,
      isValidSlug,
    );
    expect(forward).toEqual(reversed);
    expect(forward.map((d) => `${d.from}>${d.to}>${d.kind}`)).toEqual([
      "amy>aaa>wikilink",
      "amy>zzz>wikilink",
      "zed>nope>links",
      "zed>nope>wikilink",
    ]);
  });

  test("targets that are not slug-shaped are not references at all", () => {
    // Shell tests, code, and prose in double brackets must not be reported
    // (and so never reach the repair step that would unwrap them).
    expect(
      findDanglingLinks(
        [
          {
            slug: "procs/deploy",
            frontmatter: { links: ["Not A Slug"] },
            body: "Run `if [[ -f foo ]]; then` and [[ Some Prose ]] then [[real-missing]].",
          },
        ],
        known,
        isValidSlug,
      ),
    ).toEqual([{ from: "procs/deploy", to: "real-missing", kind: "wikilink" }]);
  });

  test("a fully resolved corpus yields an empty list", () => {
    expect(
      findDanglingLinks(
        [
          {
            slug: "alice",
            frontmatter: { links: [link("bob", "peer")] },
            body: "[[hub]]",
          },
          { slug: "bob", frontmatter: { edges: ["alice"] }, body: "" },
        ],
        known,
        isValidSlug,
      ),
    ).toEqual([]);
  });
});
