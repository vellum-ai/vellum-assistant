
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
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

import { cn } from "../utils/cn.js";

const MAX_CODE_BLOCK_HEIGHT = 400;

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

function buildMarkdownComponents(
  LinkComponent: MarkdownLinkComponent,
): Components {
  return {
    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
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
    ol: ({ children }) => (
      <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>
    ),
    li: ({ children }) => <li className="mb-0.5">{children}</li>,
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
    blockquote: ({ children }) => (
      <blockquote className="mb-2 border-l-2 border-stone-300 pl-3 italic text-stone-600 last:mb-0 dark:border-stone-600 dark:text-stone-400">
        {children}
      </blockquote>
    ),
    table: ({ children }) => (
      <div className="mb-2 overflow-x-auto last:mb-0">
        <table className="min-w-full border-collapse text-body-small-default">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="bg-stone-50 dark:bg-moss-800">{children}</thead>
    ),
    th: ({ children }) => (
       
      <th className={"border border-stone-200 px-2 py-1 text-left font-semibold dark:border-moss-600" /* typography: off-scale — no canonical variant */}>
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border border-stone-200 px-2 py-1 dark:border-moss-600">
        {children}
      </td>
    ),
    hr: () => (
      <hr className="my-3 border-stone-200 dark:border-moss-600" />
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
      return (
        <span className="inline-flex items-center gap-1 rounded bg-stone-100 px-1.5 py-0.5 text-body-small-default text-stone-500 dark:bg-moss-800 dark:text-stone-400">
          🔗 External image not rendered ({altStr || srcStr})
        </span>
      );
    },
  };
}

/**
 * Convert lone newlines to CommonMark hard line breaks (two trailing
 * spaces before `\n`) so user-typed Shift+Enter breaks render as `<br>`.
 * Double-newlines (paragraph breaks) are left untouched.
 */
function preserveNewlines(text: string): string {
  // Match runs of consecutive newlines. Single newlines become hard
  // breaks; runs of 2+ are paragraph separators and stay untouched.
  // Avoids lookbehind so it works on Safari/WKWebView < 16.4 (iOS 15+).
  return text.replace(/\n+/g, (m) => (m.length === 1 ? "  \n" : m));
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
}

export function MarkdownMessage({
  content,
  className,
  hardLineBreaks,
  linkComponent,
}: MarkdownMessageProps) {
  const processed = hardLineBreaks ? preserveNewlines(content) : content;
  const Link = linkComponent ?? DefaultLink;
  const components = useMemo(() => buildMarkdownComponents(Link), [Link]);
  return (
    <div data-slot="markdown-message" className={cn("text-chat text-[var(--content-default)]", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {processed}
      </ReactMarkdown>
    </div>
  );
}
