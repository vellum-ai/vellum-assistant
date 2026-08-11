/**
 * The pseudolocale: English copy, mechanically disguised, used to find copy
 * that never reached a catalog.
 *
 * The lint rule catches untranslated strings it can parse, which is not the
 * same set as the strings a user can read. It does not see copy passed to a
 * helper, returned from a function, set as a default parameter, or built by
 * concatenation. Every one of those has shipped past a clean lint run during
 * this migration. A pseudolocale inverts the question: instead of asking what
 * a rule can find in the source, it asks what is on the screen. Anything that
 * renders in plain unbracketed ASCII did not come from `t()`.
 *
 * Three transforms, each answering a different question:
 *
 * - **Accents** (`Save` to `Šàvé`) make translated text obvious at a glance,
 *   so anything still in plain English stands out without reading it.
 * - **Padding** grows each message by roughly a third, the headroom German
 *   and Finnish typically need over English, so a button or column that
 *   cannot survive translation clips here rather than in production.
 * - **Brackets** mark where a message starts and ends, so copy assembled from
 *   several `t()` calls reads as `⟦…⟧⟦…⟧` and text truncated by CSS is
 *   visibly missing its closing bracket.
 *
 * **Placeholders and markup are preserved byte for byte.** The message is
 * parsed with the same parser the runtime formats it with, which reports each
 * literal's offsets in the source; only those ranges are rewritten. Nothing
 * reconstructs the ICU syntax, so no shape of message can be mangled by a
 * serializer that did not anticipate it, and a pseudolocalized message parses
 * exactly when its source did. The accent map only produces letters, so the
 * substituted text can never introduce ICU's own metacharacters.
 *
 * The pseudolocale is not in `SUPPORTED_LOCALES`: `negotiateLocale` cannot
 * return it and the language picker does not offer it, so no user reaches it
 * by accident. It is opt-in through the stored `device:locale` preference
 * alone. See `docs/I18N.md` for how to turn it on.
 *
 * Reference: https://www.unicode.org/reports/tr35/tr35-info.html (pseudolocale
 * conventions; `en-XA` is the tag Android and Chrome use for accented English)
 */
import IntlMessageFormat from "intl-messageformat";

import type { Catalog, LocaleCatalogs } from "@/i18n/catalogs";

/**
 * ASCII letters to look-alikes carrying diacritics. Only letters map, and only
 * to letters: digits are frequently data rather than copy, and a mapping that
 * emitted `{`, `}`, `'`, or `#` would turn a literal into ICU syntax.
 */
const ACCENTS: Record<string, string> = {
  a: "à", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î",
  j: "ĵ", k: "ķ", l: "ł", m: "ɱ", n: "ñ", o: "ö", p: "þ", q: "ǫ", r: "ŕ",
  s: "š", t: "ŧ", u: "û", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "À", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Î",
  J: "Ĵ", K: "Ķ", L: "Ł", M: "Ṁ", N: "Ñ", O: "Ö", P: "Þ", Q: "Ǫ", R: "Ŕ",
  S: "Š", T: "Ŧ", U: "Û", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

/** Opens a pseudolocalized message. */
const OPEN = "⟦";

/** Closes it. Absent on screen means the message was truncated. */
const CLOSE = "⟧";

/** Filler character. Deliberately not a letter, so it reads as padding. */
const PAD = "·";

/**
 * How much longer a translation runs than its English source, as a fraction.
 * German and Finnish sit around a third for strings of this length; the
 * padding is what makes a layout that cannot take that fail here.
 */
const EXPANSION = 0.35;

function accent(text: string): string {
  let out = "";
  for (const char of text) {
    out += ACCENTS[char] ?? char;
  }
  return out;
}

/** Literal spans of an ICU message, as offsets into its source. */
interface LiteralSpan {
  start: number;
  end: number;
  value: string;
}

/**
 * The AST shape this module reads. `intl-messageformat` re-exports the node
 * types, but only literals (0), tags (8), and the branch-bearing plural (6)
 * and select (5) nodes matter here, so they are narrowed locally rather than
 * pulling the full union in.
 */
interface AstNode {
  type: number;
  value?: unknown;
  children?: AstNode[];
  options?: Record<string, { value: AstNode[] }>;
  location?: { start: { offset: number }; end: { offset: number } };
}

const LITERAL = 0;
const TAG = 8;

function collectLiterals(nodes: AstNode[], spans: LiteralSpan[]): void {
  for (const node of nodes) {
    if (node.type === LITERAL && node.location && typeof node.value === "string") {
      spans.push({
        start: node.location.start.offset,
        end: node.location.end.offset,
        value: node.value,
      });
    }
    if (node.type === TAG && node.children) {
      collectLiterals(node.children, spans);
    }
    // Plural and select carry a sub-message per branch, each with literals of
    // its own. Without this, the branch a count actually selects would render
    // in plain English and read as a miss.
    if (node.options) {
      for (const option of Object.values(node.options)) {
        collectLiterals(option.value, spans);
      }
    }
  }
}

/**
 * Pseudolocalize one ICU message.
 *
 * Returns the message unchanged apart from the wrapper if it cannot be parsed.
 * `catalogs.test.ts` proves every shipped message parses, so this only guards
 * against a catalog edit that has not run the tests yet.
 */
export function pseudoLocalizeMessage(message: string): string {
  let spans: LiteralSpan[] = [];
  try {
    const ast = new IntlMessageFormat(message, "en", undefined, {
      captureLocation: true,
    }).getAst() as AstNode[];
    collectLiterals(ast, spans);
  } catch {
    spans = [];
  }

  // Right to left, so an earlier span's offsets are still valid after a later
  // one has been spliced.
  let out = message;
  let literalLength = 0;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    literalLength += span.value.length;
    out = out.slice(0, span.start) + accent(span.value) + out.slice(span.end);
  }

  const padding = PAD.repeat(Math.ceil(literalLength * EXPANSION));
  return `${OPEN}${out}${padding}${CLOSE}`;
}

/** Pseudolocalize every message in a catalog, preserving its nesting. */
export function pseudoLocalizeCatalog(catalog: Catalog): Catalog {
  const out: Catalog = {};
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value === "string") {
      out[key] = pseudoLocalizeMessage(value);
    } else if (value && typeof value === "object") {
      out[key] = pseudoLocalizeCatalog(value as Catalog);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Derive the whole pseudolocale from the English catalogs.
 *
 * Nothing is stored on disk: the pseudolocale is a function of English, so it
 * can never fall behind it the way a hand-maintained catalog would.
 */
export function pseudoCatalogs(source: LocaleCatalogs): LocaleCatalogs {
  const out = {} as LocaleCatalogs;
  for (const [namespace, catalog] of Object.entries(source)) {
    out[namespace as keyof LocaleCatalogs] = pseudoLocalizeCatalog(catalog);
  }
  return out;
}
