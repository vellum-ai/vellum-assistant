"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { ApiRelease } from "@/lib/releases-server";
import { groupApiReleasesByMonth } from "@/lib/releases-server";

function releaseAnchor(release: ApiRelease) {
  return `v${release.version}`;
}

function getCurrentMonth() {
  const now = new Date();
  return now.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function ChevronRightIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 transition-transform duration-200 ${
        expanded ? "rotate-90" : ""
      }`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

interface ReleasesNavProps {
  releases: ApiRelease[];
}

/**
 * Sticky sidebar listing releases grouped by month, with scroll-tracked
 * highlighting via an IntersectionObserver. Desktop-only; small viewports
 * navigate the releases list through in-page anchors.
 */
export function ReleasesNav({ releases }: ReleasesNavProps) {
  const groups = groupApiReleasesByMonth(releases);
  const [activeId, setActiveId] = useState<string>("");

  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(() => {
    const currentMonth = getCurrentMonth();
    const hasCurrentMonth = groups.some((g) => g.month === currentMonth);
    const initial = hasCurrentMonth ? currentMonth : groups[0]?.month;
    return initial ? new Set([initial]) : new Set();
  });

  const toggleMonth = useCallback((month: string) => {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(month)) {
        next.delete(month);
      } else {
        next.add(month);
      }
      return next;
    });
  }, []);

  const releaseToMonth = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of groups) {
      for (const release of group.releases) {
        map.set(releaseAnchor(release), group.month);
      }
    }
    return map;
  }, [groups]);

  useEffect(() => {
    const ids = groups.flatMap((g) => g.releases.map(releaseAnchor));

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.id;
            setActiveId(id);
            const month = releaseToMonth.get(id);
            if (month) {
              setExpandedMonths((prev) => {
                if (prev.has(month)) {
                  return prev;
                }
                const next = new Set(prev);
                next.add(month);
                return next;
              });
            }
          }
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 },
    );

    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) {
        observer.observe(el);
      }
    }

    return () => observer.disconnect();
  }, [groups, releaseToMonth]);

  return (
    <nav className="docs-nav-panel hidden border-r md:sticky md:top-[101px] md:block md:h-[calc(100vh-101px)] md:w-64 md:shrink-0 md:self-start md:overflow-y-auto md:pb-8">
      <div className="px-4 pb-4 pt-4 md:pt-8">
        <div className="mb-5">
          <Link
            href="/docs/releases"
            className="docs-nav-title font-['DM_Sans',sans-serif] text-lg font-bold no-underline"
          >
            Releases
          </Link>
        </div>
        <ul className="list-none space-y-1 p-0 m-0">
          {groups.map((group) => {
            const isExpanded = expandedMonths.has(group.month);
            return (
              <li key={group.month} className="m-0 p-0">
                <button
                  type="button"
                  onClick={() => toggleMonth(group.month)}
                  className="docs-nav-section-label flex w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-bold tracking-normal normal-case text-left transition-colors hover:bg-[var(--docs-surface)] cursor-pointer"
                >
                  <ChevronRightIcon expanded={isExpanded} />
                  {group.month}
                </button>
                <div
                  className="grid transition-[grid-template-rows] duration-200 ease-out"
                  style={{
                    gridTemplateRows: isExpanded ? "1fr" : "0fr",
                  }}
                >
                  <div className="overflow-hidden">
                    <ul className="list-none space-y-0.5 p-0 m-0 pt-0.5">
                      {group.releases.map((release) => {
                        const anchor = releaseAnchor(release);
                        const isActive = activeId === anchor;
                        return (
                          <li key={release.version} className="m-0 p-0">
                            <a
                              href={`#${anchor}`}
                              className={`flex items-center justify-between rounded-lg py-2 pl-7 pr-3 text-sm no-underline transition-colors ${
                                isActive
                                  ? "docs-nav-link-active font-medium"
                                  : "docs-nav-link-inactive"
                              }`}
                            >
                              <span>v{release.version}</span>
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
