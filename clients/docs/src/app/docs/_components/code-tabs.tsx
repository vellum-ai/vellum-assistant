"use client";

import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * A segmented control that swaps between alternate versions of a step, such as
 * the same install command for macOS and Linux.
 *
 * Every panel stays mounted and is hidden with the `hidden` attribute rather
 * than being conditionally rendered. `code-block-copy` reparents each `<pre>`
 * into a wrapper element React does not know about, so unmounting a panel
 * would leave React removing a child from a stale parent.
 */

export interface CodeTab {
  id: string;
  label: string;
  content: ReactNode;
}

interface CodeTabsProps {
  tabs: CodeTab[];
  /** Describes the choice for screen readers, e.g. "Operating system". */
  label: string;
}

export function CodeTabs({ tabs, label }: CodeTabsProps) {
  const baseId = useId();
  const [activeId, setActiveId] = useState(tabs[0]?.id);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const select = (index: number): void => {
    const tab = tabs[index];
    if (!tab) {
      return;
    }
    setActiveId(tab.id);
    tabRefs.current[index]?.focus();
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      select((index + 1) % tabs.length);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      select((index - 1 + tabs.length) % tabs.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      select(0);
    } else if (event.key === "End") {
      event.preventDefault();
      select(tabs.length - 1);
    }
  };

  return (
    <div className="docs-code-tabs">
      <div className="docs-code-tabs-list" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeId;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              className={`docs-code-tabs-tab${isActive ? " is-active" : ""}`}
              onClick={() => setActiveId(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-panel-${tab.id}`}
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          className="docs-code-tabs-panel"
          hidden={tab.id !== activeId}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
