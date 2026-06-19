/**
 * Editable "Here's what I know about you" card.
 *
 * SPIKE — research-onboarding flow.
 *
 * Presentational: renders research facts as rows with a confidence badge.
 * Removing a claim doesn't delete it — the row greys out (so it isn't abrupt)
 * and the remove control opens a popover for an optional reason ("Not me" /
 * "Stale or irrelevant") or to keep it. The parent tracks removals (and reasons)
 * so it can tell the assistant about them on deeper-dive / continue. Rows with
 * sources expand on click to reveal source links below. Owns only per-row
 * expand + popover-open UI state.
 */

import { useState } from "react";
import { Ban } from "lucide-react";

import { Popover } from "@vellumai/design-library/components/popover";
import { Tag } from "@vellumai/design-library/components/tag";

import {
  confidenceBadge,
  domainFromUrl,
  REMOVAL_REASON_LABELS,
  type RemovalReason,
  type ResearchFact,
} from "@/domains/chat/onboarding-research/research-facts";
import { SourceFavicon } from "@/domains/chat/onboarding-research/source-favicon";

export interface ResearchFactItem {
  fact: ResearchFact;
  /** Stable index into the streamed fact array — the removal/remove key. */
  index: number;
}

interface ResearchFactsCardProps {
  items: ResearchFactItem[];
  /** Indices currently removed → the reason given (null if none chosen yet). */
  removals: ReadonlyMap<number, RemovalReason | null>;
  onRemove: (index: number) => void;
  onSetReason: (index: number, reason: RemovalReason) => void;
  onRestore: (index: number) => void;
  /** Heading copy (differs between streaming and settled states). */
  title: string;
  /** Resolve a favicon URL for a source domain. */
  resolveFavicon: (domain: string) => string;
}

/** Distinct {domain, url} sources for a claim (first url per domain wins). */
function sourceLinks(sources: string[]): { domain: string; url: string }[] {
  const byDomain = new Map<string, string>();
  for (const url of sources) {
    const domain = domainFromUrl(url);
    if (domain && !byDomain.has(domain)) byDomain.set(domain, url);
  }
  return [...byDomain].map(([domain, url]) => ({ domain, url }));
}

const REASONS: RemovalReason[] = ["not_me", "not_relevant"];

function ClaimRow({
  fact,
  removed,
  onRemove,
  onSetReason,
  onRestore,
  resolveFavicon,
}: {
  fact: ResearchFact;
  removed: boolean;
  onRemove: () => void;
  onSetReason: (reason: RemovalReason) => void;
  onRestore: () => void;
  resolveFavicon: (domain: string) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const badge = confidenceBadge(fact.confidence);
  const links = sourceLinks(fact.sources);
  const hasSources = links.length > 0;
  const canExpand = hasSources && !removed;

  return (
    <li
      className={`group flex flex-col rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] transition-opacity ${
        removed ? "opacity-50" : ""
      }`}
      style={{ animation: "fadeInUp 0.35s ease-out both" }}
    >
      <div
        className={`flex items-center gap-2.5 px-4 py-2.5 ${
          canExpand ? "cursor-pointer" : ""
        }`}
        onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
      >
        <span
          className={`text-[15px] leading-snug text-[var(--content-default)] ${
            removed ? "line-through" : ""
          }`}
        >
          {fact.claim}
        </span>
        <Tag tone={badge.tone}>{badge.label}</Tag>

        <Popover.Root
          open={popoverOpen}
          onOpenChange={(open) => {
            setPopoverOpen(open);
            // Opening from an active row marks it removed immediately; a reason
            // is optional and can be chosen (or skipped) from the popover.
            if (open && !removed) onRemove();
          }}
        >
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label={removed ? "Edit removal" : "Remove"}
              onClick={(e) => e.stopPropagation()}
              className={`ml-auto shrink-0 cursor-pointer text-[var(--content-tertiary)] transition-opacity hover:text-[var(--content-default)] focus-visible:opacity-100 ${
                removed ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
            >
              <Ban className="size-[18px]" />
            </button>
          </Popover.Trigger>
          <Popover.Content align="end" className="flex w-52 flex-col gap-0.5">
            <p className="px-2 pb-1 pt-1 text-label-small-default text-[var(--content-tertiary)]">
              Why remove this?
            </p>
            {REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                onClick={() => {
                  onSetReason(reason);
                  setPopoverOpen(false);
                }}
                className="rounded-md px-2 py-1.5 text-left text-sm text-[var(--content-default)] transition-colors hover:bg-[var(--surface-base)]"
              >
                {REMOVAL_REASON_LABELS[reason]}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                onRestore();
                setPopoverOpen(false);
              }}
              className="mt-0.5 rounded-md border-t border-[var(--border-base)] px-2 pt-2 pb-1 text-left text-sm text-[var(--content-secondary)] transition-colors hover:text-[var(--content-default)]"
            >
              Keep it
            </button>
          </Popover.Content>
        </Popover.Root>
      </div>

      {expanded && canExpand ? (
        <div className="flex flex-col gap-1.5 border-t border-[var(--border-base)] px-4 py-2.5">
          <span className="text-label-small-default uppercase tracking-wide text-[var(--content-tertiary)]">
            Sources
          </span>
          {links.map(({ domain, url }) => (
            <a
              key={domain}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 text-sm text-[var(--content-secondary)] transition-colors hover:text-[var(--content-default)]"
            >
              <SourceFavicon src={resolveFavicon(domain)} domain={domain} />
              {domain}
            </a>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function ResearchFactsCard({
  items,
  removals,
  onRemove,
  onSetReason,
  onRestore,
  title,
  resolveFavicon,
}: ResearchFactsCardProps) {
  return (
    <div className="flex w-full flex-col gap-3">
      <h2 className="text-lg font-medium text-[var(--content-secondary)]">
        {title}
      </h2>

      <ul className="flex flex-col gap-2">
        {items.map(({ fact, index }) => (
          <ClaimRow
            key={`${index}-${fact.claim}`}
            fact={fact}
            removed={removals.has(index)}
            onRemove={() => onRemove(index)}
            onSetReason={(reason) => onSetReason(index, reason)}
            onRestore={() => onRestore(index)}
            resolveFavicon={resolveFavicon}
          />
        ))}
      </ul>
    </div>
  );
}
