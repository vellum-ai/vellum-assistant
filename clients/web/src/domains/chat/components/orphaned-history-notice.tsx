import { Notice } from "@vellumai/design-library/components/notice";

/**
 * Shown on a conversation that read its earlier history from another
 * conversation which has since been deleted.
 *
 * Deleting a conversation orphans the forks taken from it rather than deleting
 * them too, so a fork keeps the messages it owns and simply loses the ones it
 * was reading. Without this the thread just appears to begin mid-thought, which
 * reads as data loss; naming the cause makes it read as the deletion it is.
 */
export function OrphanedHistoryNotice() {
  return (
    <Notice tone="warning">
      The conversation this one branched from was deleted, so the messages
      before the branch point are gone. Everything sent since is intact.
    </Notice>
  );
}
