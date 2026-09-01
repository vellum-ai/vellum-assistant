"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Adds a copy button to every code block under `.docs-shell`.
 *
 * Code blocks reach the page two ways: as literal `<pre>` in the page
 * components, and as markdown rendered at request time on /docs/releases. This
 * enhances the DOM after paint rather than wrapping a React component, so both
 * paths are covered, and a new page gets copy buttons without opting in.
 *
 * The button is attached to a wrapper placed *around* the horizontal scroll
 * container, not inside it, so it stays pinned while a wide block scrolls.
 */

const ENHANCED_ATTR = "data-copy-enhanced";
const COPIED_RESET_MS = 2000;

const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

/** The element to wrap: the scroll container when there is one, else the pre. */
function scrollContainerFor(pre: HTMLElement): HTMLElement {
  const parent = pre.parentElement;
  if (
    parent &&
    parent.tagName === "DIV" &&
    parent.children.length === 1 &&
    getComputedStyle(parent).overflowX === "auto"
  ) {
    return parent;
  }
  return pre;
}

function enhance(pre: HTMLElement): void {
  if (pre.getAttribute(ENHANCED_ATTR) === "true") {
    return;
  }
  pre.setAttribute(ENHANCED_ATTR, "true");

  const target = scrollContainerFor(pre);
  const parent = target.parentElement;
  if (!parent) {
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "docs-codeblock";
  parent.insertBefore(wrapper, target);
  wrapper.appendChild(target);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "docs-codeblock-copy";
  button.innerHTML = COPY_ICON;
  button.setAttribute("aria-label", "Copy code");

  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener("click", () => {
    const text = pre.textContent ?? "";
    if (!text) {
      return;
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        button.innerHTML = CHECK_ICON;
        button.setAttribute("aria-label", "Code copied");
        button.classList.add("is-copied");
        if (resetTimer) {
          clearTimeout(resetTimer);
        }
        resetTimer = setTimeout(() => {
          button.innerHTML = COPY_ICON;
          button.setAttribute("aria-label", "Copy code");
          button.classList.remove("is-copied");
        }, COPIED_RESET_MS);
      })
      .catch(() => {
        // Clipboard writes fail in restricted contexts (no permission, or a
        // non-secure origin). Leave the block selectable instead.
      });
  });

  wrapper.appendChild(button);
}

export function CodeBlockCopy() {
  const pathname = usePathname();

  useEffect(() => {
    const root = document.querySelector(".docs-shell");
    if (!root) {
      return;
    }

    const run = (): void => {
      root.querySelectorAll<HTMLElement>("pre").forEach(enhance);
    };

    run();

    // /docs/releases renders its markdown after the first paint, and the
    // release list grows as more months load, so keep watching for new blocks.
    const observer = new MutationObserver(run);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [pathname]);

  return null;
}
