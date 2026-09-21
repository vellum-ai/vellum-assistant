/**
 * The evidence a `recall` result stands on, in the order recall ranked it:
 * each item's title, where it lives (the place searched, then the page,
 * conversation or file and line), and the excerpt that matched.
 *
 * Laid out like the tools a loaded skill provides (`SkillToolList`): a plain
 * list with the name first and the prose under it, so the drawer reads the
 * same whichever tool opened it.
 */

import type { RecallEvidenceItem } from "@vellumai/assistant-api";
import { Typography } from "@vellumai/design-library";

import { MachineText } from "@/components/detail-primitives";
import { useRecallSourceLabel } from "@/domains/chat/components/tool-activity/recall-labels";

interface RecallEvidenceRowProps {
  item: RecallEvidenceItem;
  /** What the drawer calls the place this item was found. */
  sourceLabel: string;
}

function RecallEvidenceRow({ item, sourceLabel }: RecallEvidenceRowProps) {
  return (
    <li className="min-w-0">
      <Typography
        variant="body-medium-default"
        as="p"
        className="break-words text-[var(--content-default)]"
      >
        {item.title}
      </Typography>
      <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
        <Typography
          variant="body-small-lighter"
          as="span"
          className="shrink-0 text-[var(--content-tertiary)]"
        >
          {sourceLabel}
        </Typography>
        <MachineText
          tone="muted"
          className="min-w-0 truncate"
          title={item.locator}
        >
          {item.locator}
        </MachineText>
      </div>
      {item.excerpt && (
        <Typography
          variant="body-small-lighter"
          as="p"
          className="mt-1 break-words text-[var(--content-secondary)]"
        >
          {item.excerpt}
        </Typography>
      )}
    </li>
  );
}

interface RecallEvidenceListProps {
  evidence: readonly RecallEvidenceItem[];
}

export function RecallEvidenceList({ evidence }: RecallEvidenceListProps) {
  const sourceLabel = useRecallSourceLabel();
  return (
    <ul className="flex flex-col gap-4">
      {evidence.map((item, index) => (
        <RecallEvidenceRow
          key={`${index}:${item.locator}`}
          item={item}
          sourceLabel={sourceLabel(item.source)}
        />
      ))}
    </ul>
  );
}
