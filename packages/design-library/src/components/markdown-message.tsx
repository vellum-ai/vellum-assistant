
import { Check, Copy } from "lucide-react";
import {
  type AnchorHTMLAttributes,
  Children,
  isValidElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Components } from "react-markdown";
import "katex/dist/katex.min.css";

import { cn } from "../utils/cn";

const MAX_CODE_BLOCK_HEIGHT = 400;

export const quoteBlockquoteClassName = cn(
  "mx-0 mt-0 mb-3 flex w-full items-center gap-3 rounded-md bg-[var(--surface-sunken)] px-3 py-2.5 text-body-small-default text-[var(--content-secondary)] last:mb-0",
);
export const quoteBlockquoteAccentClassName =
  "h-5 w-0.5 shrink-0 rounded-full bg-[var(--content-tertiary)]";
export const quoteBlockquoteContentClassName = "min-w-0 flex-1 [&_p]:mb-0";

function CopyButton({ visible, onClick, copied }: {
  visible: boolean;
  onClick: () => void;
  copied: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? "Copied!" : "Copy"}
      className={cn(
        // Touch devices (hover: none): always visible since hover isn't available.
        // Constraint: WKWebView on Capacitor iOS lacks hover events.
        "flex h-6 w-6 cursor-pointer items-center justify-center rounded-md bg-stone-200/80 text-[var(--content-tertiary)] transition-[opacity] duration-150 ease-out hover:bg-stone-300 hover:text-[var(--content-secondary)] [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100 dark:bg-moss-600/80 dark:hover:bg-moss-500 dark:hover:text-stone-200",
        visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <div className="relative h-3.5 w-3.5">
        <Check
          className={cn(
            "absolute inset-0 h-3.5 w-3.5 text-[var(--system-positive-strong)] transition-opacity duration-150 ease-out",
            copied ? "opacity-100" : "opacity-0",
          )}
        />
        <Copy
          className={cn(
            "absolute inset-0 h-3.5 w-3.5 transition-opacity duration-150 ease-out",
            copied ? "opacity-0" : "opacity-100",
          )}
        />
      </div>
    </button>
  );
}

function CodeBlockWrapper({ children }: { children: ReactNode }) {
  const [showCopied, setShowCopied] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [hasFocusWithin, setHasFocusWithin] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const childArray = Children.toArray(children);
  const codeChild = childArray.find(
    (child) =>
      isValidElement(child) &&
      (child.props as { className?: string }).className?.startsWith("language-"),
  );
  const language = isValidElement(codeChild)
    ? (codeChild.props as { className?: string }).className
        ?.replace("language-", "")
    : undefined;

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? "";
    navigator.clipboard.writeText(text).then(() => {
      setShowCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setShowCopied(false);
        timerRef.current = null;
      }, 1500);
    }).catch(() => {});
  }, []);

  const buttonVisible = isHovered || hasFocusWithin;

  return (
    <div
      className="group/code relative mb-2 overflow-hidden rounded-md bg-stone-100 last:mb-0 dark:bg-moss-800"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onFocus={() => setHasFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          setHasFocusWithin(false);
        }
      }}
    >
      {language && (
        <div className="flex items-center justify-between px-3 pt-2">
          {/* typography: off-scale — monospace language label */}
          { }
          <span className="font-mono text-xs font-medium uppercase text-[var(--content-tertiary)]">
            {language}
          </span>
          <CopyButton
            visible={buttonVisible}
            onClick={handleCopy}
            copied={showCopied}
          />
        </div>
      )}
      <pre
        ref={preRef}
        className="overflow-x-auto p-3"
        style={{ maxHeight: MAX_CODE_BLOCK_HEIGHT, overflowY: "auto" }}
      >
        {children}
      </pre>
      {!language && (
        <div className="absolute right-2 top-2">
          <CopyButton
            visible={buttonVisible}
            onClick={handleCopy}
            copied={showCopied}
          />
        </div>
      )}
    </div>
  );
}

function DefaultLink({
  href,
  children,
}: Pick<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children">) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-forest-600 underline hover:text-forest-700 dark:text-forest-400 dark:hover:text-forest-300"
    >
      {children}
    </a>
  );
}

export type MarkdownLinkComponent = (
  props: Pick<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children">,
) => ReactNode;

export type MarkdownImageComponent = (
  props: { src: string; alt: string },
) => ReactNode;

/**
 * Browser-default `<em>` italic synthesizes an oblique skew on every glyph in
 * the run — including color-emoji glyphs — so `*🥺*` renders a slanted emoji.
 * We wrap emoji grapheme runs in a `font-style: normal` span so they render
 * upright while the surrounding emphasized text stays italic.
 *
 * Emoji detection: U+FE0F (VS16) forces emoji presentation; U+FE0E (VS15)
 * forces text presentation; otherwise the Unicode `Emoji_Presentation` property
 * decides. This keeps digits / `#` / `*` (bare Emoji but text-presentation) and
 * VS15 sequences italic.
 */
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u; // fast-path gate only
const VS16 = "️"; // variation selector forcing emoji presentation
const VS15 = "︎"; // variation selector forcing text presentation

function graphemeRendersAsEmoji(grapheme: string): boolean {
  if (grapheme.includes(VS16)) return true;
  if (grapheme.includes(VS15)) return false;
  return EMOJI_PRESENTATION.test(grapheme);
}

// Module-level singleton. Grapheme segmentation keeps multi-scalar emoji intact
// (ZWJ sequences, skin-tone modifiers, flags, keycaps). Guarded for any runtime
// that lacks Intl.Segmenter — there we leave the text untouched.
const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * Split `text` into runs, wrapping emoji runs in a `font-style: normal` span so
 * they render upright inside an italic ancestor. Returns the bare string when
 * there is nothing to un-italicize (the overwhelmingly common case).
 */
function splitEmojiRuns(text: string): ReactNode {
  // Bail fast when there is no emoji-ish codepoint. The VS16 check catches
  // sequences whose base char isn't Extended_Pictographic (e.g. keycaps `1️⃣`).
  if (!PICTOGRAPHIC.test(text) && !text.includes(VS16)) return text;
  if (!graphemeSegmenter) return text;

  const runs: ReactNode[] = [];
  let buffer = "";
  let bufferIsEmoji = false;
  let key = 0;
  const flush = () => {
    if (!buffer) return;
    runs.push(
      bufferIsEmoji ? (
        <span key={key++} style={{ fontStyle: "normal" }}>
          {buffer}
        </span>
      ) : (
        buffer
      ),
    );
    buffer = "";
  };
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const isEmoji = graphemeRendersAsEmoji(segment);
    if (buffer && isEmoji !== bufferIsEmoji) flush();
    bufferIsEmoji = isEmoji;
    buffer += segment;
  }
  flush();
  // A single text run means no emoji were found — return the plain string so the
  // output is byte-identical to having no override.
  return runs.length === 1 && typeof runs[0] === "string" ? runs[0] : runs;
}

/** Apply emoji-upright wrapping to `<em>` children (a string, or mixed array). */
function renderUprightEmoji(children: ReactNode): ReactNode {
  if (typeof children === "string") return splitEmojiRuns(children);
  return Children.map(children, (child) =>
    typeof child === "string" ? splitEmojiRuns(child) : child,
  );
}

function buildMarkdownComponents(
  LinkComponent: MarkdownLinkComponent,
  ImageComponent?: MarkdownImageComponent,
): Components {
  return {
    // mb-6 (24px) equals one --text-chat-line-height, so a `\n\n` paragraph
    // break reads as a full blank line — distinct from the 24px hard break a
    // single `\n` produces. Smaller margins make the two nearly identical.
    p: ({ children }) => <p className="mb-6 last:mb-0">{children}</p>,
    // Markdown headings keep the canonical scale sizes but restore bold weight
    // via `!font-bold` (the scale variants bake font-weight:500 into the utility,
    // so a plain `font-bold` loses to the custom rule; `!important` wins).
    h1: ({ children }) => (
      // typography: off-scale — bold weight override on canonical size
       
      <h1 className="mb-2 mt-3 text-title-medium !font-bold first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      // typography: off-scale — bold weight override on canonical size
       
      <h2 className="mb-2 mt-3 text-title-small !font-bold first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      // typography: off-scale — bold weight override on canonical size
       
      <h3 className="mb-1 mt-2 text-body-medium-default !font-bold first:mt-0">{children}</h3>
    ),
    ul: ({ children }) => (
      <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>
    ),
    // `start` must be forwarded: react-markdown emits `<ol start="N">` for a
    // list that begins at a non-1 number (a bare "3." answer, or a list the
    // model continues from a prior number). Dropping it silently renumbers
    // every such list to 1 — e.g. "3." would render as "1.".
    ol: ({ children, start }) => (
      <ol start={start} className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>
    ),
    // h4-h6 are rare in assistant output but must not fall through to
    // unstyled browser defaults (a Tailwind reset strips their size/weight,
    // leaving them indistinguishable from body text). Keep them bold on a
    // descending body scale.
    h4: ({ children }) => (
      // typography: off-scale — bold weight override on canonical size

      <h4 className="mb-1 mt-2 text-body-medium-default !font-bold first:mt-0">{children}</h4>
    ),
    h5: ({ children }) => (
      // typography: off-scale — bold weight override on canonical size

      <h5 className="mb-1 mt-2 text-body-small-default !font-bold first:mt-0">{children}</h5>
    ),
    h6: ({ children }) => (
      // typography: off-scale — bold weight override on canonical size

      <h6 className="mb-1 mt-2 text-body-small-default !font-bold text-[var(--content-secondary)] first:mt-0">{children}</h6>
    ),
    // `value` is forwarded so a list item whose source ordinal breaks the
    // running sequence (set by remarkPreserveOrderedListNumbers) renders at its
    // typed number via the HTML `<li value="N">` attribute.
    li: ({ children, value }) => <li value={value} className="mb-0.5">{children}</li>,
    a: ({ href, children }) => <LinkComponent href={href}>{children}</LinkComponent>,
    code: ({ className, children, ...props }) => {
      const isBlock = className?.startsWith("language-");
      if (isBlock) {
        return (
          <code
            className={cn("block overflow-x-auto font-mono text-body-small-default", className)}
            {...props}
          >
            {children}
          </code>
        );
      }
      return (
        <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-body-small-default dark:bg-moss-800">
          {children}
        </code>
      );
    },
    pre: ({ children }) => <CodeBlockWrapper>{children}</CodeBlockWrapper>,
    // No styling change vs. the browser default `<em>`, except emoji inside the
    // emphasis render upright instead of skewed (see splitEmojiRuns).
    em: ({ children }) => <em>{renderUprightEmoji(children)}</em>,
    blockquote: ({ children }) => (
      <blockquote className={quoteBlockquoteClassName}>
        <span aria-hidden="true" className={quoteBlockquoteAccentClassName} />
        <div className={quoteBlockquoteContentClassName}>{children}</div>
      </blockquote>
    ),
    table: ({ children }) => (
      <div className="mb-2 overflow-x-auto last:mb-0">
        <table className="min-w-full border-collapse text-body-small-default">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="bg-[var(--surface-sunken)]">{children}</thead>
    ),
    th: ({ children }) => (
       
      <th className={"border border-stone-200 px-2 py-1 text-left font-semibold [&_code]:whitespace-pre-wrap [&_code]:break-words [&_code]:box-decoration-clone [&_code]:leading-relaxed dark:border-moss-600" /* typography: off-scale — no canonical variant */}>
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border border-stone-200 px-2 py-1 [&_code]:whitespace-pre-wrap [&_code]:break-words [&_code]:box-decoration-clone [&_code]:leading-relaxed dark:border-moss-600">
        {children}
      </td>
    ),
    hr: () => (
      <hr className="my-3 border-[var(--border-subtle)]" />
    ),
    img: ({ src, alt }) => {
      const srcStr = typeof src === "string" ? src : "";
      const altStr = typeof alt === "string" ? alt : "";
      const isLocal =
        !srcStr ||
        srcStr.startsWith("/") ||
        srcStr.startsWith("data:") ||
        srcStr.startsWith("blob:") ||
        srcStr.startsWith(".");
      if (isLocal) {
        return <img src={srcStr} alt={altStr} className="my-1 max-w-full rounded" />;
      }
      if (ImageComponent) {
        return <ImageComponent src={srcStr} alt={altStr} />;
      }
      return (
        <span className="inline-flex items-center gap-1 rounded bg-stone-100 px-1.5 py-0.5 text-body-small-default text-stone-500 dark:bg-moss-800 dark:text-stone-400">
          🔗 External image not rendered ({altStr || srcStr})
        </span>
      );
    },
  };
}

/**
 * A currency amount: `$` immediately followed by a digit, with optional
 * thousands separators, a decimal, and a K/M/B/T(/bn/tn/trn) scale suffix,
 * ending at a word/punctuation boundary. Intentionally narrow so real math is
 * preserved — `$E = mc^2$`, `$x^2$`, `$\frac12$` have no digit after `$`, and
 * `$2x + 1$` has the digit followed by a variable rather than a boundary.
 *
 * The boundary set includes the en-dash `–` and em-dash `—` (not just the
 * plain hyphen `-`) because ranges like `$12K–$17K` are common; without them
 * the opening `$` of the first amount stays unescaped and pairs with the next
 * `$` into an italic math span. `–—` are literal members of the class; the
 * plain `-` stays last so it is never read as a range operator.
 *
 * A trailing `+` (the "or more" idiom) is consumed as part of any amount,
 * bare (`$50+`) or suffixed (`$1M+`, `$500K+`), so those amounts terminate at
 * a clean boundary. It is deliberately NOT a general boundary char: in
 * `$1+1$` the char after the `+` is a digit rather than a boundary, so real
 * arithmetic math is preserved.
 */
const CURRENCY_AMOUNT =
  /\$(\d[\d,]*(?:\.\d+)?(?:bn|tn|trn|[KMBT])?\+?)(?=$|[\s).,;:!?%"'’\]}/–—-]|&)/gi;

/**
 * remark-math treats `$…$` as inline LaTeX, so monetary text like
 * "$65B series H at $965B post-money" gets greedily paired into a math span
 * and mangled into italic math typography. We defuse this by escaping the
 * leading `$` of currency amounts (`\$`) so the math tokenizer skips them.
 *
 * The escape MUST happen on the source string before react-markdown parses
 * (once `$…$` is paired into a math node it is too late, and reverting the
 * node would also swallow the `$` that opens any adjacent real equation). But
 * a blind string replace would also rewrite verbatim regions — inline code,
 * fenced code, link destinations, autolinks — leaking a stray backslash into
 * text that must stay exact.
 *
 * So we first parse the markdown *structure* (GFM, but no math) and rewrite
 * currency only inside `text` nodes. Code spans, code blocks, and link/image
 * destinations are non-text nodes, so they are left byte-for-byte intact. A
 * `$` preceded by `$` (a `$$…$$` fence) or `\` (already escaped) is skipped.
 */
const structureParser = unified().use(remarkParse).use(remarkGfm);

/**
 * Source offset ranges of every `text` node in `content`, in document order.
 * Verbatim regions — inline code, fenced code, link/image destinations,
 * autolinks — are non-`text` nodes, so they are excluded: a rewrite scoped to
 * these ranges leaves them byte-for-byte intact. Shared by currency escaping
 * and soft-break conversion so both stay confined to prose.
 */
function collectTextRanges(content: string): Array<[number, number]> {
  const tree = structureParser.parse(content);
  const ranges: Array<[number, number]> = [];
  const collect = (node: { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: unknown[] }) => {
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (typeof start === "number" && typeof end === "number") {
        ranges.push([start, end]);
      }
      return;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        collect(child as Parameters<typeof collect>[0]);
      }
    }
  };
  collect(tree as Parameters<typeof collect>[0]);
  return ranges;
}

/**
 * Rebuild `content`, applying `rewrite` to each text-node slice while copying
 * the verbatim gaps between them (code, links, …) untouched. `rewrite`
 * receives the slice and its source start offset (for cross-boundary lookups).
 */
function rewriteTextSlices(
  content: string,
  ranges: Array<[number, number]>,
  rewrite: (slice: string, start: number) => string,
): string {
  let result = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue; // defensive: never reprocess overlapping spans
    result += content.slice(cursor, start); // verbatim gap (code, links, …)
    result += rewrite(content.slice(start, end), start);
    cursor = end;
  }
  result += content.slice(cursor);
  return result;
}

function escapeCurrencyDollars(content: string): string {
  // Fast path: nothing that looks like `$<digit>` means no work to do.
  if (!/\$\d/.test(content)) return content;
  const ranges = collectTextRanges(content);
  if (ranges.length === 0) return content;
  return rewriteTextSlices(content, ranges, (slice, start) =>
    slice.replace(CURRENCY_AMOUNT, (match, amount: string, offset: number) => {
      const prev = offset > 0 ? slice[offset - 1] : start > 0 ? content[start - 1] : "";
      if (prev === "$" || prev === "\\") return match;
      return `\\$${amount}`;
    }),
  );
}

/**
 * Convert lone newlines to CommonMark hard line breaks (two trailing spaces
 * before `\n`) so single-`\n` breaks — common in both user-typed Shift+Enter
 * input and assistant output — render as `<br>` instead of collapsing to a
 * space.
 *
 * Like currency escaping, the rewrite is scoped to `text` nodes. A blind
 * string replace would also append trailing spaces *inside fenced code blocks*
 * (corrupting code) and to table-row source; confining it to prose avoids
 * both. Paragraph breaks (`\n\n`) never appear within a single text node — a
 * blank line terminates the block — so every `\n` reached here is a soft break
 * safe to harden.
 */
function hardBreakNewlines(content: string): string {
  if (!content.includes("\n")) return content;
  const ranges = collectTextRanges(content);
  if (ranges.length === 0) return content;
  return rewriteTextSlices(content, ranges, (slice) => slice.replace(/\n/g, "  \n"));
}

/** Leading marker of an ordered-list item: up to 3 spaces, digits, then `.`/`)`. */
const ORDERED_MARKER = /^\s{0,3}(\d{1,9})[.)]/;

/**
 * remark plugin: render an ordered list with the exact numbers the author typed.
 *
 * CommonMark keeps only an ordered list's *first* item number — emitted as the
 * `<ol start>` — and discards every later marker, so a list written as
 * `1. / 2. / 4. / 5.` silently renumbers to 1, 2, 3, 4. For each item we recover
 * the literal ordinal from the source and, wherever it breaks the running
 * sequence, pin it with `data.hProperties.value` — which react-markdown's
 * mdast→hast step turns into an HTML `<li value="N">` that overrides the
 * browser's auto-increment. Items that already match the running count emit no
 * `value`, so contiguous lists render byte-identically to no plugin at all.
 */
function remarkPreserveOrderedListNumbers() {
  return (tree: unknown, file: { toString(): string }) => {
    const source = String(file);
    const visit = (node: {
      type: string;
      ordered?: boolean;
      start?: number | null;
      position?: { start: { offset?: number } };
      data?: { hProperties?: Record<string, unknown> };
      children?: unknown[];
    }) => {
      if (node.type === "list" && node.ordered && Array.isArray(node.children)) {
        let counter = node.start ?? 1;
        for (const child of node.children) {
          const item = child as Parameters<typeof visit>[0];
          const offset = item.position?.start.offset;
          let literal = counter;
          if (typeof offset === "number") {
            const marker = ORDERED_MARKER.exec(source.slice(offset, offset + 16));
            if (marker) literal = Number(marker[1]);
          }
          if (literal !== counter) {
            item.data ??= {};
            item.data.hProperties ??= {};
            item.data.hProperties.value = literal;
          }
          counter = literal + 1;
        }
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          visit(child as Parameters<typeof visit>[0]);
        }
      }
    };
    visit(tree as Parameters<typeof visit>[0]);
  };
}

export interface MarkdownMessageProps {
  content: string;
  className?: string;
  /** When true, single newlines render as hard line breaks. */
  hardLineBreaks?: boolean;
  /**
   * Custom link component for rendering `<a>` elements inside markdown.
   * Receives `href` and `children` props. Defaults to a plain
   * `<a target="_blank" rel="noopener noreferrer">`.
   *
   * Pass a stable reference (module-level function or `useCallback`) to
   * avoid rebuilding internal component overrides on every render.
   */
  linkComponent?: MarkdownLinkComponent;
  /**
   * Custom image component for rendering external `<img>` elements inside
   * markdown. Receives `src` and `alt` props. By default, external images
   * are blocked and show a placeholder label.
   *
   * Pass a stable reference (module-level function or `useCallback`) to
   * avoid rebuilding internal component overrides on every render.
   */
  imageComponent?: MarkdownImageComponent;
  /**
   * Custom URL transform applied to link, image, and definition URLs.
   * Overrides react-markdown's default sanitization which only allows
   * `http:`, `https:`, `mailto:`, and a few other schemes. Use this to
   * permit custom URI schemes (e.g. `vellum://`).
   *
   * @see https://github.com/remarkjs/react-markdown?tab=readme-ov-file#urltransform
   */
  urlTransform?: (url: string) => string;
}

export function MarkdownMessage({
  content,
  className,
  hardLineBreaks,
  linkComponent,
  imageComponent,
  urlTransform,
}: MarkdownMessageProps) {
  const processed = useMemo(() => {
    const escaped = escapeCurrencyDollars(content);
    return hardLineBreaks ? hardBreakNewlines(escaped) : escaped;
  }, [content, hardLineBreaks]);
  const Link = linkComponent ?? DefaultLink;
  const components = useMemo(() => buildMarkdownComponents(Link, imageComponent), [Link, imageComponent]);
  return (
    <div data-slot="markdown-message" className={cn("text-chat text-[var(--content-default)]", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, remarkPreserveOrderedListNumbers]} rehypePlugins={[rehypeKatex]} components={components} urlTransform={urlTransform}>
        {processed}
      </ReactMarkdown>
    </div>
  );
}
