/**
 * Tests for the pseudolocale transform.
 *
 * The property that matters is narrow: a pseudolocalized message must format
 * exactly where its source formatted, with the same placeholders, the same
 * plural categories, and the same markup. Everything else about it is
 * cosmetic. The last test therefore runs the transform over every message in
 * every shipped English catalog rather than over fixtures, so a catalog entry
 * whose shape this module has not met fails here.
 */
import { describe, expect, test } from "bun:test";
import IntlMessageFormat from "intl-messageformat";

import { FALLBACK_CATALOGS } from "@/i18n/catalogs";
import { pseudoCatalogs, pseudoLocalizeMessage } from "@/i18n/pseudo-locale";
import { NAMESPACES } from "@/i18n/namespaces";

/**
 * Every argument name a message references, from its AST.
 *
 * Read from the parse rather than by pattern: a `plural` branch opens with a
 * brace too, so a regex over the source cannot tell `{survivor}` from the `{`
 * that starts the `=0 {No new channels…}` body.
 */
function argumentNames(message: string): string[] {
  interface Node {
    type: number;
    value?: unknown;
    children?: Node[];
    options?: Record<string, { value: Node[] }>;
  }
  const names: string[] = [];
  const walk = (nodes: Node[]): void => {
    for (const node of nodes) {
      // 0 is a literal and 7 is the `#` of a plural; 8 is a tag, whose `value`
      // is its name. Everything between them names an argument.
      if (node.type >= 1 && node.type <= 6 && typeof node.value === "string") {
        names.push(node.value);
      }
      if (node.children) {
        walk(node.children);
      }
      if (node.options) {
        for (const option of Object.values(node.options)) {
          walk(option.value);
        }
      }
    }
  };
  walk(new IntlMessageFormat(message, "en").getAst() as Node[]);
  return names.sort();
}

/** Format a message the way the runtime does, so the assertions see real output. */
function format(message: string, values: Record<string, unknown> = {}): string {
  return String(new IntlMessageFormat(message, "en").format(values));
}

/** Every leaf message of a catalog, keyed by its dotted path. */
function flatten(value: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value === "string") {
    out[prefix] = value;
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      Object.assign(out, flatten(child, prefix ? `${prefix}.${key}` : key));
    }
  }
  return out;
}

describe("pseudoLocalizeMessage", () => {
  test("accents the letters of a plain message", () => {
    const out = pseudoLocalizeMessage("Save");
    expect(out).toContain("Šàṽé");
    expect(out).not.toContain("Save");
  });

  test("brackets the message so truncation is visible", () => {
    const out = pseudoLocalizeMessage("Save");
    expect(out.startsWith("⟦")).toBe(true);
    expect(out.endsWith("⟧")).toBe(true);
  });

  test("pads the message to leave room for a longer translation", () => {
    // 30 letters of source, so the padding is a third of that and the message
    // is meaningfully wider than its English.
    const source = "Notes about yourself which AI";
    const out = pseudoLocalizeMessage(source);
    expect(out.length).toBeGreaterThan(source.length * 1.3);
    expect(out).toContain("·");
  });

  test("leaves a placeholder's name untouched and still substitutes it", () => {
    const out = pseudoLocalizeMessage("Delete {name}?");

    expect(out).toContain("{name}");
    expect(format(out, { name: "Ada" })).toContain("Ada");
  });

  test("accents inside plural branches, and still selects the right one", () => {
    const source =
      "{count, plural, one {# interaction} other {# interactions}}";
    const out = pseudoLocalizeMessage(source);

    // The branch a count selects is the copy a user reads. Left in plain
    // English it would read as a miss on every screen showing a count.
    expect(format(out, { count: 1 })).toContain("îñŧéŕàçŧîöñ");
    expect(format(out, { count: 5 })).toContain("îñŧéŕàçŧîöñš");
    expect(format(out, { count: 1 })).toContain("1");
    expect(format(out, { count: 7 })).toContain("7");
  });

  test("keeps an explicit plural branch selectable", () => {
    const out = pseudoLocalizeMessage(
      "{count, plural, =0 {No channels} one {# channel} other {# channels}}",
    );

    expect(format(out, { count: 0 })).toContain("Ñö çĥàññéłš");
    expect(format(out, { count: 2 })).toContain("2");
  });

  test("preserves tag names while accenting what they wrap", () => {
    const out = pseudoLocalizeMessage("Marks it <emphasis>linked</emphasis>.");

    expect(out).toContain("<emphasis>");
    expect(out).toContain("</emphasis>");
    expect(out).toContain("łîñķéð");
  });

  test("preserves a number placeholder's format", () => {
    const out = pseudoLocalizeMessage("Used {bytes, number} of space");

    expect(out).toContain("{bytes, number}");
    expect(format(out, { bytes: 1234 })).toContain("1,234");
  });

  test("wraps a message that is nothing but a placeholder", () => {
    const out = pseudoLocalizeMessage("{name}");

    expect(out).toBe("⟦{name}⟧");
    expect(format(out, { name: "Ada" })).toBe("⟦Ada⟧");
  });

  test("returns something formattable for a message it cannot parse", () => {
    // Not reachable from a catalog that passes `catalogs.test.ts`, but a
    // malformed entry must not take the app down before those tests run.
    const out = pseudoLocalizeMessage("{unclosed");

    expect(out).toContain("{unclosed");
  });
});

describe("pseudoCatalogs", () => {
  test("covers every namespace", () => {
    const catalogs = pseudoCatalogs(FALLBACK_CATALOGS);

    expect(Object.keys(catalogs).sort()).toEqual([...NAMESPACES].sort());
  });

  test("preserves the nesting the key paths depend on", () => {
    const catalogs = pseudoCatalogs(FALLBACK_CATALOGS);
    const source = flatten(FALLBACK_CATALOGS);
    const pseudo = flatten(catalogs);

    expect(Object.keys(pseudo).sort()).toEqual(Object.keys(source).sort());
  });

  test("every shipped English message survives the transform", () => {
    const source = flatten(FALLBACK_CATALOGS);
    const pseudo = flatten(pseudoCatalogs(FALLBACK_CATALOGS));

    const broken: string[] = [];
    for (const [key, message] of Object.entries(pseudo)) {
      try {
        new IntlMessageFormat(message, "en");
      } catch {
        broken.push(key);
        continue;
      }
      // Every argument the source names must still be named, or a screen in
      // the pseudolocale would be missing data the real one shows.
      if (
        argumentNames(source[key]).join(",") !== argumentNames(message).join(",")
      ) {
        broken.push(key);
      }
    }

    expect(broken).toEqual([]);
  });
});
