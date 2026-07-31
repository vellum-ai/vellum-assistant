"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

interface TocItem {
  id: string;
  label: string;
  level: number;
}

interface TableOfContentsProps {
  items: TocItem[];
  /** Optional content rendered below the TOC list, inside the sticky column. */
  footer?: ReactNode;
}

const PEEK_SCROLL_THRESHOLD_PX = 240;

export function TableOfContents({ items, footer }: TableOfContentsProps) {
  const [activeId, setActiveId] = useState<string>("");
  const [peekVisible, setPeekVisible] = useState(false);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const [peekLeft, setPeekLeft] = useState<number | null>(null);

  // Anchor the peek bubble to the TOC menu column: measure where the
  // menu list actually sits and pin the bubble's left edge to it, so
  // they stay aligned at any viewport width.
  useEffect(() => {
    const measure = () => {
      const el = columnRef.current;
      if (el) {
        // pl-6 on the column puts the menu list 24px in from the column edge.
        setPeekLeft(el.getBoundingClientRect().left + 24);
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    if (items.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const firstVisible = entries.find((entry) => entry.isIntersecting);
        if (firstVisible) {
          setActiveId(firstVisible.target.id);
        }
      },
      {
        rootMargin: "-80px 0px -60% 0px",
        threshold: 0,
      }
    );

    for (const item of items) {
      const element = document.getElementById(item.id);
      if (element) {
        observer.observe(element);
      }
    }

    return () => {
      observer.disconnect();
    };
  }, [items]);

  // Reveal the peek bubble once the reader scrolls past the threshold;
  // hide it again when they return to the top so it never crowds the hero.
  useEffect(() => {
    const onScroll = () => {
      setPeekVisible(window.scrollY > PEEK_SCROLL_THRESHOLD_PX);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (items.length === 0) {
    return null;
  }

  return (
    <div
      ref={columnRef}
      className="hidden w-52 shrink-0 self-start pl-6 lg:sticky lg:top-20 lg:block"
    >
      <div className="max-h-[calc(100vh-5rem)] overflow-y-auto">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          On this page
        </div>
        <ul className="list-none space-y-1 border-l border-zinc-200 p-0 m-0">
          {items.map((item) => {
            const isActive = activeId === item.id;
            return (
              <li key={item.id} className="m-0 p-0">
                <a
                  href={`#${item.id}`}
                  className={`block border-l-2 py-1 text-xs no-underline transition-colors ${
                    item.level === 3 ? "pl-6" : "pl-3"
                  } ${
                    isActive
                      ? "border-emerald-500 font-medium text-emerald-700"
                      : "border-transparent text-zinc-500 hover:text-zinc-700"
                  }`}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
      {footer ? <div className="mt-4">{footer}</div> : null}
      {/* Speech bubble that peeks up from the bottom of the viewport, right
          side of the TOC column, once the reader scrolls into the page. It
          invites the reader to the community Discord. */}
      <div
        className="docs-toc-peek-wrapper"
        style={{
          position: "fixed",
          ...(peekLeft === null
            ? { right: "max(0px, calc((100vw - 1280px) / 2 + 1.5rem))" }
            : { left: peekLeft }),
          bottom: -74,
          width: 160,
          height: 160,
          opacity: peekVisible ? 1 : 0,
          transform: peekVisible ? "translateY(0)" : "translateY(96px)",
          transition: "opacity 320ms ease, transform 320ms cubic-bezier(0.22, 1, 0.36, 1)",
          zIndex: 10,
        }}
      >
        <a
          href="https://discord.gg/ZABd9V2zM8"
          target="_blank"
          rel="noopener noreferrer"
          className="docs-toc-peek-bubble"
          style={{
            position: "absolute",
            bottom: 168,
            right: -10,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
            padding: "12px 18px",
            background: "#fff",
            border: "1px solid #e4e4e7",
            borderRadius: 14,
            fontSize: 13,
            fontWeight: 500,
            lineHeight: 1.4,
            color: "#18181b",
            textDecoration: "none",
            whiteSpace: "nowrap",
            textAlign: "center",
            transition: "transform 200ms ease",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 127.14 96.36"
              fill="#5865F2"
            >
              <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z" />
            </svg>
            Come say hi
          </span>
          <span>in the community!</span>
          {/* Bubble tail pointing down: two stacked triangles, gray behind
              for the border, white on top for the fill. Nested inside the
              bubble so it moves with the hover lift. */}
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              bottom: -11,
              right: 67,
              width: 0,
              height: 0,
              borderLeft: "9px solid transparent",
              borderRight: "9px solid transparent",
              borderTop: "11px solid #e4e4e7",
            }}
          />
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              bottom: -9,
              right: 68,
              width: 0,
              height: 0,
              borderLeft: "8px solid transparent",
              borderRight: "8px solid transparent",
              borderTop: "10px solid #fff",
            }}
          />
        </a>
      </div>
      <style>{`
        .docs-toc-peek-wrapper:hover .docs-toc-peek-bubble {
          transform: translateY(-2px);
        }
      `}</style>
    </div>
  );
}
