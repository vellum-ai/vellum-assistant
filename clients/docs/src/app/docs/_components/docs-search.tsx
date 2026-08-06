"use client";

import { Search, Rocket, BookOpen, Shield, CreditCard, Globe } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  useCallback,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { DocsSearchResponse, DocsSearchResult } from "@/lib/docs/search/types";
import { tokenize } from "@/lib/docs/search/text";
import { lockBodyScroll, unlockBodyScroll } from "@/app/docs/_components/body-scroll-lock";

const MIN_QUERY_LENGTH = 2;
const SPOTLIGHT_TRANSITION_MS = 220;

const SUGGESTED_SECTIONS = [
  {
    label: "Getting Started",
    description: "Install Vellum and set up your first assistant",
    url: "/docs/getting-started",
    icon: Rocket,
  },
  {
    label: "Key Concepts",
    description: "Understand workspaces, memory, channels, and more",
    url: "/docs/key-concepts",
    icon: BookOpen,
  },
  {
    label: "Trust & Security",
    description: "Review privacy, permissions, and security best practices",
    url: "/docs/trust-security",
    icon: Shield,
  },
  {
    label: "Hosting options",
    description: "Compare local, Apple Container, GCP, and AWS hosting choices",
    url: "/docs/hosting-options",
    icon: Globe,
  },
  {
    label: "Pricing",
    description: "Understand credits, usage, and how to add credits",
    url: "/docs/pricing",
    icon: CreditCard,
  },
] as const;

function renderHighlightedText(text: string, query: string): ReactNode {
  const tokens = Array.from(new Set(tokenize(query))).sort((a, b) => b.length - a.length);
  if (tokens.length === 0) {
    return text;
  }

  const escapedTokens = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(${escapedTokens.join("|")})`, "ig");
  const parts = text.split(regex);

  return parts.map((part, index) => {
    if (!part) {
      return null;
    }

    if (tokens.some((token) => token.toLowerCase() === part.toLowerCase())) {
      return <mark key={`mark-${index}`}>{part}</mark>;
    }

    return <span key={`text-${index}`}>{part}</span>;
  });
}

interface DocsSearchProps {
  /**
   * Whether this instance owns the global Cmd/Ctrl+K shortcut. Exactly one
   * mounted instance should register it; duplicates open overlapping dialogs.
   */
  registerShortcut?: boolean;
}

export function DocsSearch({ registerShortcut = true }: DocsSearchProps) {
  const router = useRouter();
  const pathname = usePathname();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocsSearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [spotlightMounted, setSpotlightMounted] = useState(false);
  const [spotlightOpen, setSpotlightOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const canSearch = query.trim().length >= MIN_QUERY_LENGTH;

  const resetSearchState = useCallback(() => {
    setQuery("");
    setResults([]);
    setActiveIndex(0);
    setLoading(false);
  }, []);

  const openSpotlight = useCallback(() => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setSpotlightMounted(true);
    window.requestAnimationFrame(() => {
      setSpotlightOpen(true);
    });
  }, []);

  const closeSpotlight = useCallback(
    (immediate = false) => {
      setSpotlightOpen(false);

      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }

      const finalizeClose = () => {
        setSpotlightMounted(false);
        resetSearchState();
      };

      if (immediate) {
        finalizeClose();
        return;
      }

      closeTimerRef.current = window.setTimeout(() => {
        finalizeClose();
        closeTimerRef.current = null;
      }, SPOTLIGHT_TRANSITION_MS);
    },
    [resetSearchState],
  );

  useEffect(() => {
    // Dismiss the spotlight when navigation changes the pathname.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    closeSpotlight(true);
  }, [closeSpotlight, pathname]);

  useEffect(() => {
    if (!registerShortcut && !spotlightOpen) {
      return;
    }

    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (!isShortcut) {
        if (event.key === "Escape" && spotlightOpen) {
          closeSpotlight();
        }
        return;
      }

      if (registerShortcut) {
        event.preventDefault();
        openSpotlight();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => {
      window.removeEventListener("keydown", handleShortcut);
    };
  }, [closeSpotlight, openSpotlight, registerShortcut, spotlightOpen]);

  useEffect(() => {
    if (!spotlightMounted) {
      return;
    }

    lockBodyScroll();
    return () => {
      unlockBodyScroll();
    };
  }, [spotlightMounted]);

  useEffect(() => {
    if (spotlightOpen) {
      inputRef.current?.focus();
    }
  }, [spotlightOpen]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // The portal target only exists in the browser DOM, so it is resolved
    // after mount rather than during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPortalRoot((document.querySelector(".docs-shell") as HTMLElement | null) ?? document.body);
  }, []);

  useEffect(() => {
    if (!spotlightMounted) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }

    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const controller = new AbortController();

    const timeout = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: trimmed, limit: "10" });
        const response = await fetch(`/docs/api/search?${params.toString()}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          setResults([]);
          return;
        }

        const data = (await response.json()) as DocsSearchResponse;
        setResults(data.results ?? []);
        setActiveIndex(0);
      } catch {
        if (!controller.signal.aborted) {
          setResults([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 150);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [query, spotlightMounted]);

  const activeResult = useMemo(() => {
    if (results.length === 0) {
      return null;
    }

    return results[Math.min(Math.max(activeIndex, 0), results.length - 1)] ?? null;
  }, [activeIndex, results]);

  const openResult = (result: DocsSearchResult) => {
    // result.url is a dynamic docs path from the search index; the cast is needed for Next.js typed routes
    (router.push as (url: string) => void)(result.url);
    closeSpotlight(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (results.length === 0 ? 0 : (current + 1) % results.length));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => {
        if (results.length === 0) {
          return 0;
        }

        return current === 0 ? results.length - 1 : current - 1;
      });
      return;
    }

    if (event.key === "Enter" && activeResult) {
      event.preventDefault();
      openResult(activeResult);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeSpotlight();
    }
  };

  return (
    <>
      <div className="docs-search">
        <button
          type="button"
          className="docs-search-trigger"
          onClick={openSpotlight}
          aria-label="Open documentation search"
          aria-haspopup="dialog"
          aria-expanded={spotlightMounted}
        >
          <Search size={16} className="docs-search-icon" />
          <span className="docs-search-trigger-text">Search docs...</span>
          <span className="docs-search-shortcut">⌘K</span>
        </button>
      </div>

      {spotlightMounted && portalRoot
        ? createPortal(
            <div
              className={`docs-search-spotlight-overlay ${spotlightOpen ? "is-open" : ""}`}
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  closeSpotlight();
                }
              }}
            >
              <div
                className={`docs-search-spotlight ${spotlightOpen ? "is-open" : ""}`}
                role="dialog"
                aria-modal="true"
                aria-label="Search documentation"
              >
                <div className="docs-search-spotlight-input-wrap">
                  <Search size={20} className="docs-search-spotlight-icon" />
                  <input
                    id="docs-spotlight-input"
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="Search documentation..."
                    className="docs-search-spotlight-input"
                    aria-label="Search documentation"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-haspopup="listbox"
                    aria-expanded={spotlightOpen}
                    aria-controls="docs-search-results"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="docs-search-esc"
                    onClick={() => closeSpotlight()}
                    aria-label="Close search"
                  >
                    Esc
                  </button>
                </div>

                <div id="docs-search-results" className="docs-search-spotlight-results" role="listbox">
                  {loading && <div className="docs-search-status">Searching...</div>}

                  {!loading && !canSearch && (
                    <div className="docs-search-suggestions">
                      <div className="docs-search-suggestions-label">Suggested</div>
                      <ul className="docs-search-list">
                        {SUGGESTED_SECTIONS.map((section) => {
                          const Icon = section.icon;
                          return (
                            <li key={section.url} className="docs-search-item-wrapper">
                              <button
                                type="button"
                                className="docs-search-item docs-search-suggestion-item"
                                onClick={() => {
                                  (router.push as (url: string) => void)(section.url);
                                  closeSpotlight(true);
                                }}
                              >
                                <div className="docs-search-suggestion-icon">
                                  <Icon size={16} />
                                </div>
                                <div>
                                  <div className="docs-search-title">{section.label}</div>
                                  <div className="docs-search-snippet">{section.description}</div>
                                </div>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {!loading && canSearch && results.length === 0 && (
                    <div className="docs-search-status">No matching docs yet.</div>
                  )}

                  {!loading && results.length > 0 && (
                    <ul className="docs-search-list">
                      {results.map((result, index) => {
                        const selected = index === activeIndex;
                        return (
                          <li key={result.id} className="docs-search-item-wrapper">
                            <button
                              type="button"
                              className={`docs-search-item ${selected ? "is-active" : ""}`}
                              onMouseEnter={() => setActiveIndex(index)}
                              onClick={() => openResult(result)}
                              role="option"
                              aria-selected={selected}
                            >
                              <div className="docs-search-title-row">
                                <span className="docs-search-title">{renderHighlightedText(result.heading, query)}</span>
                                <span className="docs-search-page">{result.pageTitle}</span>
                              </div>
                              {result.snippet && (
                                <div className="docs-search-snippet">{renderHighlightedText(result.snippet, query)}</div>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            </div>,
            portalRoot,
          )
        : null}
    </>
  );
}
