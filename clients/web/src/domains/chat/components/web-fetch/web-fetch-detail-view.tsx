/**
 * The body for a `web_fetch` call: a clickable source card, the fetch's
 * warnings, and the extracted page as readable markdown. The source and the
 * warnings come from the daemon's `activityMetadata.webFetch`; the result text
 * is written for the model, and is parsed only to split the page body out of
 * it, and for history recorded before the metadata existed. The unparsed
 * result is Raw output, which the drawer offers below every call.
 *
 * Parsing only: it reads the `result` and metadata its host resolved and never
 * re-fetches. Both are live wherever the host has a live source, so a fetch
 * that lands while the drawer is open reaches the reader.
 */

import { useMemo } from "react";

import type { WebFetchMetadata } from "@vellumai/assistant-api";
import { CardRoot, Notice, Typography } from "@vellumai/design-library";

import { ExternalAnchor, isWebUrl } from "@/components/external-anchor";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import {
  ClampedContent,
  CodeBlock,
  SectionLabel,
} from "@/components/detail-primitives";
import { ToolOutputBody } from "@/domains/chat/components/tool-activity/tool-output-body";
import { SiteFavicon } from "@/domains/chat/components/web-search/site-favicon";
import { extractDomain } from "@/domains/chat/utils/web-search-result-text";
import { readToolInputString } from "@/domains/chat/utils/tool-input";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import { useTranslation } from "@/i18n";

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
  let body =
    markerIdx >= 0 ? text.slice(markerIdx + CONTENT_MARKER.length) : text;

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
      if (m && m[1].trim()) {
        notices.push(m[1].trim());
      }
    }
  }

  // Strip the `<external_content …>` wrapper, capturing its `origin` as a
  // last-resort url source.
  body = body.trim();
  let originUrl: string | null = null;
  const open = body.match(/^<external_content\b([^>]*)>\s*/);
  if (open) {
    const originMatch = open[1].match(/origin="([^"]+)"/);
    if (originMatch) {
      originUrl = originMatch[1];
    }
    body = body
      .slice(open[0].length)
      .replace(/\s*<\/external_content>\s*$/, "");
  }

  return {
    url:
      field("Final URL") ||
      field("Requested URL") ||
      originUrl ||
      fallbackUrl ||
      null,
    status: field("Status"),
    notices,
    content: body.trim(),
  };
}

/** What the source card shows, from the metadata or the parsed header. */
interface WebFetchSource {
  url: string;
  /** Status as shown, e.g. `"200"` or, from an old header, `"200 OK"`. */
  status: string | null;
  title?: string;
  domain: string;
  faviconUrl?: string;
}

function sourceFromMetadata(meta: WebFetchMetadata): WebFetchSource | null {
  const url = meta.finalUrl || meta.url;
  if (!url) {
    return null;
  }
  return {
    url,
    // 0 means no response arrived, so there is no status to show.
    status: meta.status > 0 ? String(meta.status) : null,
    title: meta.title,
    domain: meta.domain || hostnameOf(url),
    faviconUrl: meta.faviconUrl,
  };
}

/**
 * The page a fetch read or tried. A link only to an `http(s)` url that parses
 * to a host: the url can be one the daemon refused (`file:`, `mailto:`, a bare
 * word, or a malformed `https://[` the model passed), and that reads as text,
 * never as a target.
 */
function SourceCard({ source }: { source: WebFetchSource }) {
  const { url, status, title, domain, faviconUrl } = source;
  const name = title || domain || url;
  const ok = status ? /^\s*2\d\d/.test(status) : false;
  const body = (
    <>
      <SiteFavicon faviconUrl={faviconUrl} domain={domain} title={name} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Typography
          variant="body-medium-default"
          as="span"
          className="truncate text-[var(--content-default)]"
        >
          {name}
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
    </>
  );
  if (!isWebUrl(url) || !extractDomain(url)) {
    return (
      <CardRoot
        surface="overlay"
        padding="sm"
        className="flex items-center gap-2"
      >
        {body}
      </CardRoot>
    );
  }
  return (
    <CardRoot
      asChild
      interactive
      surface="overlay"
      padding="sm"
      className="flex items-center gap-2"
    >
      <ExternalAnchor href={url} glyph={false}>
        {body}
      </ExternalAnchor>
    </CardRoot>
  );
}

export function WebFetchDetailView({
  detail,
  result,
  activityMetadata,
  isRunning,
  isError,
  isDenied,
}: ToolActivityRendererProps) {
  const { t } = useTranslation("chat");
  const meta = activityMetadata?.webFetch;
  // The live result, not the open-time snapshot: this renderer owns its output,
  // so a fetch that lands while the drawer is open reaches the user only if the
  // view reads what `ToolDetailBody` resolved.
  const body = typeof result === "string" ? result : "";
  // `parseWebFetchResult` distinguishes an absent fallback from an empty one,
  // so a blank url stays `undefined` rather than becoming "".
  const fallbackUrl = readToolInputString(detail.input, "url") || undefined;
  const parsed = useMemo(
    () => parseWebFetchResult(body, fallbackUrl),
    [body, fallbackUrl],
  );

  const source: WebFetchSource | null = meta
    ? sourceFromMetadata(meta)
    : parsed.url
      ? {
          url: parsed.url,
          status: parsed.status,
          domain: hostnameOf(parsed.url),
        }
      : null;

  // Metadata that carries `startIndexPastEnd` (true or false) carries every
  // warning a reader acts on: a page cut short, one that may need JavaScript,
  // a start past the end of the page, and a hosted provider's own warning (its
  // words, so shown as sent). Its other notices (a redirect, `max_chars`) are
  // for the model: the card already shows the final url, and a cut-short page
  // is a cut-short page whatever cut it. Metadata without it came from an
  // assistant that predates those fields, so the result text's notices stay
  // what the reader sees, as they always have.
  const notices =
    meta?.startIndexPastEnd !== undefined
      ? [
          ...(meta.truncated ? [t("webFetchDetailView.truncated")] : []),
          ...(meta.mayRequireJavaScript
            ? [t("webFetchDetailView.mayRequireJavaScript")]
            : []),
          ...(meta.startIndexPastEnd
            ? [t("webFetchDetailView.startIndexPastEnd")]
            : []),
          ...(meta.providerWarning ? [meta.providerWarning] : []),
        ]
      : parsed.notices;

  // A refused fetch never ran: its result is the daemon's note to the model,
  // which reads as a failed fetch if shown, so the refusal is what it says.
  if (isDenied) {
    return (
      <ToolOutputBody text="" isDenied isRunning={false} isError={false} />
    );
  }

  // A failed fetch has no page to read, so its error shows verbatim, under the
  // page it tried when the metadata names one.
  if (isError) {
    return (
      <div className="flex flex-col gap-5">
        {meta && source && <SourceCard source={source} />}
        <CodeBlock
          text={body || t("webFetchDetailView.fetchFailed")}
          tone="error"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {source && <SourceCard source={source} />}

      {notices.length > 0 && (
        <div className="flex flex-col gap-2">
          {notices.map((notice, i) => (
            <Notice key={i} tone="warning">
              {notice}
            </Notice>
          ))}
        </div>
      )}

      <div>
        <SectionLabel>{t("toolDetailPanel.output")}</SectionLabel>
        {parsed.content ? (
          // Deliberately NO `assistantId`: this is text extracted from a
          // remote page, the least-trusted content in the app. Passing one
          // would let a fetched page's `![](vellum://workspace/…)` reference
          // pull local workspace bytes into the panel and render them as if
          // the page had supplied them. Local-file references keep degrading
          // to an inert card here; a remote page has no business naming a
          // file in the user's workspace.
          <ClampedContent label={t("toolDetailPanel.output")}>
            <ChatMarkdownMessage content={parsed.content} />
          </ClampedContent>
        ) : (
          <ToolOutputBody
            text=""
            isRunning={isRunning}
            isDenied={false}
            isError={false}
          />
        )}
      </div>
    </div>
  );
}
