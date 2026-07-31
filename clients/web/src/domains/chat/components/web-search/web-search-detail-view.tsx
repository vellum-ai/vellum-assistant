/**
 * Nested detail view for a subagent "Searching the web" query pill: the search
 * query rendered verbatim, then the sources it returned as the same favicon
 * source chips the timeline uses. Opened in-place by `SubagentDetailPanel` when
 * a query pill is clicked — the search analogue of the thinking pill's reasoning
 * view.
 *
 * Static / presentational: reads only the `searchQuery` + `searchResults` the
 * panel already built into the `ToolDetailPayload` (see
 * `buildSubagentStepDetails`), so it never re-parses or fetches.
 */

import { Typography } from "@vellumai/design-library";

import { WebSearchStepRow } from "@/domains/chat/components/web-search/web-search-step-row";
import type { ToolDetailPayload } from "@/stores/viewer-store";

export function WebSearchDetailView({ detail }: { detail: ToolDetailPayload }) {
  const query = detail.searchQuery ?? "";
  const results = detail.searchResults ?? [];

  return (
    <div className="flex flex-col gap-5">
      {query ? (
        <div className="flex flex-col gap-2">
          <Typography
            variant="body-medium-default"
            as="h3"
            className="text-[var(--content-emphasised)]"
          >
            Query
          </Typography>
          <Typography
            variant="body-medium-lighter"
            as="p"
            className="break-words leading-relaxed text-[var(--content-default)]"
          >
            {`"${query}"`}
          </Typography>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Typography
          variant="body-medium-default"
          as="h3"
          className="text-[var(--content-emphasised)]"
        >
          {results.length > 0 ? `Sources (${results.length})` : "Sources"}
        </Typography>
        {results.length > 0 ? (
          // Reuse the timeline's source-chip cluster so the detail and the
          // timeline present identical visuals for the same sources.
          <WebSearchStepRow
            step={{
              kind: "web_search",
              title: "Searched the web",
              durationLabel: "",
              linkCount: results.length,
              results,
            }}
          />
        ) : (
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
          >
            No sources found.
          </Typography>
        )}
      </div>
    </div>
  );
}
