/**
 * The body for a web search: the query as written, then the sources it
 * returned as the same favicon source chips the timeline uses. Every host of a
 * tool detail renders it through the renderer registry.
 *
 * Its result states come from `ToolOutputBody`, like every renderer that owns
 * its output: a search still running says so, a refused one says it did not
 * run, and a failure shows its error. Only a finished search with no results
 * says it found no sources.
 *
 * It reads the `searchQuery` and `searchResults` its payload was built with
 * (see `toolDetailPayloadFromToolCall`), so it never re-parses or fetches.
 */

import { Typography } from "@vellumai/design-library";

import { SectionLabel } from "@/components/detail-primitives";
import { ToolOutputBody } from "@/domains/chat/components/tool-activity/tool-output-body";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import { WebSearchStepRow } from "@/domains/chat/components/web-search/web-search-step-row";
import { useTranslation } from "@/i18n";

export function WebSearchDetailView({
  detail,
  result,
  isRunning,
  isError,
  isDenied,
}: ToolActivityRendererProps) {
  const { t } = useTranslation("chat");
  const query = detail.searchQuery ?? "";
  const results = detail.searchResults ?? [];
  const finished = !isRunning && !isError && !isDenied;

  return (
    <div className="flex flex-col gap-5">
      {query && (
        <div>
          <SectionLabel>{t("webSearchDetailView.query")}</SectionLabel>
          <Typography
            variant="body-medium-lighter"
            as="p"
            className="break-words text-[var(--content-default)]"
          >
            {query}
          </Typography>
        </div>
      )}

      <div>
        <SectionLabel>
          {results.length > 0
            ? t("webSearchDetailView.sourcesWithCount", {
                count: results.length,
              })
            : t("webSearchDetailView.sources")}
        </SectionLabel>
        {results.length > 0 ? (
          // The timeline's own source-chip cluster, so the detail and the
          // timeline show the same sources the same way.
          <WebSearchStepRow
            step={{
              kind: "web_search",
              title: "Searched the web",
              durationLabel: "",
              linkCount: results.length,
              results,
            }}
          />
        ) : finished ? (
          <Typography
            variant="body-small-default"
            as="p"
            className="text-[var(--content-tertiary)]"
          >
            {t("webSearchDetailView.noSources")}
          </Typography>
        ) : (
          <ToolOutputBody
            text={typeof result === "string" ? result : ""}
            isDenied={isDenied}
            isRunning={isRunning}
            isError={isError}
          />
        )}
      </div>
    </div>
  );
}
