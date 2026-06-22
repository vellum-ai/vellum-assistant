/**
 * Live research activity feed for the focused-onboarding loading state.
 *
 * SPIKE — research-onboarding flow.
 *
 * While the assistant researches, the turn store streams structured web
 * activity (`liveWebActivity`, keyed by tool-call id) and a human-readable
 * `statusText`. This renders that activity as cards that fly in — the searches
 * it runs and the pages it reads — so the wait reads as visible progress
 * instead of a spinner. Cohesive with how the transcript surfaces tool
 * activity, just in a focused, single-column presentation.
 *
 * Lives in the chat domain because it reads chat-domain (turn) state.
 */

import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import type {
  ToolActivityMetadata,
  WebSearchResultItem,
} from "@/assistant/web-activity-types";
import { useTurnStore } from "@/domains/chat/turn-store";
import { SourceFavicon } from "@/domains/chat/onboarding-research/source-favicon";

interface SearchItem {
  kind: "search";
  id: string;
  query: string;
  results: WebSearchResultItem[];
}

interface FetchItem {
  kind: "fetch";
  id: string;
  title: string;
  domain: string;
  faviconUrl?: string;
}

type FeedItem = SearchItem | FetchItem;

function toFeedItems(
  activity: Record<string, ToolActivityMetadata>,
): FeedItem[] {
  const items: FeedItem[] = [];
  for (const [id, meta] of Object.entries(activity)) {
    if (meta.webSearch) {
      items.push({
        kind: "search",
        id,
        query: meta.webSearch.query,
        results: meta.webSearch.results ?? [],
      });
    } else if (meta.webFetch) {
      const f = meta.webFetch;
      items.push({
        kind: "fetch",
        id,
        title: f.title?.trim() || f.domain,
        domain: f.domain,
        faviconUrl: f.faviconUrl,
      });
    }
  }
  return items;
}

/** Reassurance copy that escalates as the research runs long. */
function useElapsedHint(): string | null {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(t);
  }, []);
  if (elapsed > 150_000) return "Still going — deep research can take a couple of minutes.";
  if (elapsed > 60_000) return "Digging a little deeper…";
  return null;
}

export function ResearchActivityFeed() {
  const liveWebActivity = useTurnStore((s) => s.liveWebActivity);
  const statusText = useTurnStore((s) => s.statusText);
  const elapsedHint = useElapsedHint();

  const items = toFeedItems(liveWebActivity);

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-medium text-[var(--content-default)]">
          Getting to know you…
        </h2>
        <p className="text-body-medium-lighter text-[var(--content-secondary)]">
          {statusText ?? "Searching the web to get to know you."}
        </p>
        {elapsedHint ? (
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            {elapsedHint}
          </p>
        ) : null}
      </div>

      {items.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] px-5 py-4">
          <Search className="size-4 shrink-0 animate-pulse text-[var(--content-tertiary)]" />
          <span className="text-base text-[var(--content-secondary)]">
            Warming up the search…
          </span>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] px-5 py-4"
              style={{ animation: "fadeInUp 0.35s ease-out both" }}
            >
              {item.kind === "search" ? (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-3">
                    <Search className="size-4 shrink-0 text-[var(--content-secondary)]" />
                    <span className="text-base text-[var(--content-default)]">
                      Searching for{" "}
                      <span className="font-medium">“{item.query}”</span>
                    </span>
                  </div>
                  {item.results.length > 0 ? (
                    <div className="flex flex-wrap gap-2 pl-7">
                      {item.results.slice(0, 5).map((r) => (
                        <span
                          key={`${item.id}-${r.rank}-${r.url}`}
                          className="flex items-center gap-1.5 rounded-full border border-[var(--border-element)] bg-[var(--surface-base)] px-2.5 py-1 text-label-small-default text-[var(--content-secondary)]"
                          title={r.title}
                          style={{ animation: "fadeInUp 0.3s ease-out both" }}
                        >
                          <SourceFavicon src={r.faviconUrl} domain={r.domain} />
                          {r.domain}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <SourceFavicon src={item.faviconUrl} domain={item.domain} />
                  <span className="min-w-0 text-base text-[var(--content-default)]">
                    Reading <span className="font-medium">{item.title}</span>
                    <span className="text-[var(--content-tertiary)]">
                      {" "}
                      · {item.domain}
                    </span>
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
