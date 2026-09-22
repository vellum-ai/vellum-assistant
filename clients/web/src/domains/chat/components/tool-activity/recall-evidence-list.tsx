/**
 * The evidence a `recall` result stands on, in the order recall ranked it, as
 * design-library `ListRow`s: the item's title, the excerpt that matched, and
 * the place it was found. An item from a workspace file or memory page opens
 * that file in the drawer, the same preview a file link in chat opens; an
 * item from a conversation opens the conversation at the matching message;
 * anything else is a readout.
 */

import type { RecallEvidenceItem } from "@vellumai/assistant-api";
import { ListRow, Typography } from "@vellumai/design-library";

import {
  LocalFileIcon,
  localFileKindFromFilename,
} from "@/components/local-file/local-file-icon";
import { openLocalFile } from "@/components/local-file/open-local-file";
import { RecallConversationRow } from "@/domains/chat/components/tool-activity/recall-conversation-row";
import { useRecallSourceLabel } from "@/domains/chat/components/tool-activity/recall-labels";
import { workspaceBasenameOf } from "@/utils/workspace-path-links";

interface RecallEvidenceRowProps {
  item: RecallEvidenceItem;
  /** What the drawer calls the place this item was found. */
  sourceLabel: string;
  /** Needed to read a file into the drawer rather than the workspace browser. */
  assistantId?: string | null;
}

function RecallEvidenceRow({
  item,
  sourceLabel,
  assistantId,
}: RecallEvidenceRowProps) {
  const subtitle = item.excerpt || undefined;
  const trailing = (
    <Typography
      variant="body-small-lighter"
      as="span"
      className="text-[var(--content-tertiary)]"
    >
      {sourceLabel}
    </Typography>
  );
  if (item.conversationId) {
    return (
      <RecallConversationRow
        conversationId={item.conversationId}
        messageId={item.messageId}
        title={item.title}
        subtitle={subtitle}
        trailing={trailing}
      />
    );
  }
  const path = item.path;
  if (path) {
    const filename = workspaceBasenameOf(path);
    return (
      <ListRow
        role="listitem"
        leading={
          <LocalFileIcon
            kind={localFileKindFromFilename(filename)}
            filename={filename}
            className="h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
          />
        }
        title={item.title}
        subtitle={subtitle}
        trailing={trailing}
        onClick={() => openLocalFile(path, filename, assistantId ?? undefined)}
      />
    );
  }
  return (
    <ListRow
      role="listitem"
      title={item.title}
      subtitle={subtitle}
      trailing={trailing}
    />
  );
}

interface RecallEvidenceListProps {
  evidence: readonly RecallEvidenceItem[];
  /** Needed to read a file into the drawer rather than the workspace browser. */
  assistantId?: string | null;
}

export function RecallEvidenceList({
  evidence,
  assistantId,
}: RecallEvidenceListProps) {
  const sourceLabel = useRecallSourceLabel();
  // Rows stack flush: `ListRow` draws the hairline between siblings. The
  // negative margin lines each row's text up with the section label, since
  // the row pads itself for its hover fill.
  return (
    <div role="list" className="-mx-2">
      {evidence.map((item, index) => (
        <RecallEvidenceRow
          key={`${index}:${item.locator}`}
          item={item}
          sourceLabel={sourceLabel(item.source)}
          assistantId={assistantId}
        />
      ))}
    </div>
  );
}
