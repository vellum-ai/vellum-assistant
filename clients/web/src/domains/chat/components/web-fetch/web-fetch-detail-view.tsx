/**
 * Nested detail view for a subagent `web_fetch` pill. The raw tool result is a
 * metadata header (`Requested URL` / `Final URL` / `Status` / `Content-Type` /
 * `Notices`) wrapping the extracted page text inside an `<external_content>`
 * tag. Rather than dump that verbatim, this view renders a clickable source
 * card, surfaces the fetch notices (truncation / JS-rendered warnings), and
 * shows the extracted text as readable markdown — with a "View raw" toggle for
 * the unparsed result.
 *
 * Static / presentational: parses only the `input` + `result` the panel already
 * built into the `ToolDetailPayload` (see `buildSubagentStepDetails`); never
 * re-fetches.
 */

import { useMemo, useState } from "react";

import { Typography } from "@vellumai/design-library";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { CodeBlock } from "@/domains/chat/components/tool-detail-panel";
import { SiteFavicon } from "@/domains/chat/components/web-search/site-favicon";
import { extractDomain } from "@/domains/chat/utils/web-search-result-text";
import type { ToolDetailPayload } from "@/stores/viewer-store";

const CONTENT_MARKER = "\nContent:\n";

export interface ParsedWebFetch {
  /** Best available source URL (final → requested → external_content origin). */
  url: string | null;
  /** HTTP status line, e.g. `"200 OK"`. */
  status: string | null;
  /** Fetch notices (truncation, JS-render warnings) shown as a banner. */
  notices: string[];
  /** Extracted page text with the `<external_content>` wrapper stripped. */
  content: string;
}

/** Hostname (minus a leading `www.`) for display, or the raw url on parse failure. */
export function hostnameOf(url: string): string {
  // Reuse the canonical chat-domain parser (`new URL().hostname` minus `www.`);
  // it returns "" on parse failure, so fall back to the raw url for display.
  return extractDomain(url) || url;
}

/**
 * Split a `web_fetch` result into its metadata header and extracted body. When
 * the `Content:` marker is absent (e.g. an error result) the whole string is
 * treated as content so nothing is silently dropped.
 */
export function parseWebFetchResult(
  result: string,
  fallbackUrl?: string,
): ParsedWebFetch {
  const text = result ?? "";
  const markerIdx = text.indexOf(CONTENT_MARKER);
  const header = markerIdx >= 0 ? text.slice(0, markerIdx) : "";
  let body = markerIdx >= 0 ? text.slice(markerIdx + CONTENT_MARKER.length) : text;

  const field = (label: string): string | null => {
    const m = header.match(new RegExp(`^${label}:[ \\t]*(.+)$`, "m"));
    return m ? m[1].trim() : null;
  };

  // Notices: the bullet lines under a `Notices:` heading.
  const notices: string[] = [];
  const noticesIdx = header.indexOf("Notices:");
  if (noticesIdx >= 0) {
    for (const line of header.slice(noticesIdx).split("\n")) {
      const m = line.match(/^\s*-\s+(.*)$/);
      if (m && m[1].trim()) notices.push(m[1].trim());
    }
  }

  // Strip the `<external_content …>` wrapper, capturing its `origin` as a
  // last-resort url source.
  body = body.trim();
  let originUrl: string | null = null;
  const open = body.match(/^<external_content\b([^>]*)>\s*/);
  if (open) {
    const originMatch = open[1].match(/origin="([^"]+)"/);
    if (originMatch) originUrl = originMatch[1];
    body = body
      .slice(open[0].length)
      .replace(/\s*<\/external_content>\s*$/, "");
  }

  return {
    url: field("Final URL") || field("Requested URL") || originUrl || fallbackUrl || null,
    status: field("Status"),
    notices,
    content: body.trim(),
  };
}

function SourceCard({ url, status }: { url: string; status: string | null }) {
  const host = hostnameOf(url);
  const ok = status ? /^\s*2\d\d/.test(status) : false;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3 transition-colors hover:border-[var(--border-hover)]"
    >
      <SiteFavicon domain={host} title={host} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Typography
          variant="body-medium-default"
          as="span"
          className="truncate text-[var(--content-default)]"
        >
          {host}
        </Typography>
        <Typography
          variant="body-small-default"
          as="span"
          className="truncate text-[var(--content-tertiary)]"
        >
          {url}
        </Typography>
      </div>
      {status && (
        <span
          className={`shrink-0 rounded-[6px] px-2 py-0.5 text-body-small-emphasised ${
            ok
              ? "text-[var(--system-positive-strong)]"
              : "text-[var(--content-tertiary)]"
          }`}
        >
          {status}
        </span>
      )}
    </a>
  );
}

export function WebFetchDetailView({ detail }: { detail: ToolDetailPayload }) {
  const [showRaw, setShowRaw] = useState(false);
  const fallbackUrl =
    typeof detail.input?.url === "string" ? detail.input.url : undefined;
  const parsed = useMemo(
    () => parseWebFetchResult(detail.result ?? "", fallbackUrl),
    [detail.result, fallbackUrl],
  );

  // A failed fetch has no parseable body — show the raw error verbatim.
  if (detail.status === "error") {
    return <CodeBlock text={detail.result ?? "Fetch failed."} />;
  }

  return (
    <div className="flex flex-col gap-5">
      {parsed.url && <SourceCard url={parsed.url} status={parsed.status} />}

      {parsed.notices.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3">
          {parsed.notices.map((notice, i) => (
            <Typography
              key={i}
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
            >
              {notice}
            </Typography>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Typography
            variant="body-medium-default"
            as="h3"
            className="text-[var(--content-emphasised)]"
          >
            {showRaw ? "Raw result" : "Content"}
          </Typography>
          {detail.result && (
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="cursor-pointer text-[var(--content-secondary)] transition-colors hover:text-[var(--content-default)]"
            >
              <Typography variant="label-small-default" as="span">
                {showRaw ? "View extracted" : "View raw"}
              </Typography>
            </button>
          )}
        </div>
        {showRaw ? (
          <CodeBlock text={detail.result ?? ""} />
        ) : parsed.content ? (
          <ChatMarkdownMessage content={parsed.content} />
        ) : (
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
          >
            {detail.status === "running" ? "Fetching…" : "No content extracted."}
          </Typography>
        )}
      </div>
    </div>
  );
}
