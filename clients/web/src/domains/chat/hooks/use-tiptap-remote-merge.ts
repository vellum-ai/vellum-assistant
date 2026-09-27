import type { Editor, EditorEvents } from "@tiptap/core";
import { toast } from "@vellumai/design-library";
import { useLayoutEffect, useRef } from "react";

import { getEditorMarkdown } from "@/domains/chat/components/tiptap-editor-extensions";
import {
  parseEditorMarkdown,
  RemoteMergeTracker,
  serializeEditorDoc,
} from "@/domains/chat/utils/tiptap-remote-merge";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";

interface UseTiptapRemoteMergeOptions {
  editor: Editor | null;
  /** The document body from outside the editor, e.g. a streamed assistant edit. */
  content: string;
  /** The body the save path last wrote. */
  sentContent: string | undefined;
  /** The merged body differs from `content` and needs saving. */
  onMerged: ((markdown: string) => void) | undefined;
}

/**
 * Merges each new `content` into the mounted editor as a remote change
 * (see `utils/tiptap-remote-merge.ts`), keeping the user's unsaved text,
 * selection and undo history. A skipped conflicting hunk raises a toast.
 */
export function useTiptapRemoteMerge({
  editor,
  content,
  sentContent,
  onMerged,
}: UseTiptapRemoteMergeOptions): void {
  const { t } = useTranslation("chat");
  const onMergedRef = useRef(onMerged);
  useLayoutEffect(() => {
    onMergedRef.current = onMerged;
  });
  const trackerRef = useRef<{
    editor: Editor;
    tracker: RemoteMergeTracker;
  } | null>(null);
  // The editor is created from the first render's content.
  const mergedContentRef = useRef(content);

  useLayoutEffect(() => {
    if (!editor) {
      return;
    }
    const entry = { editor, tracker: new RemoteMergeTracker(editor.state.doc) };
    trackerRef.current = entry;
    const onTransaction = ({
      transaction,
      appendedTransactions,
    }: EditorEvents["transaction"]) => {
      entry.tracker.applyTransaction(transaction);
      for (const appended of appendedTransactions) {
        entry.tracker.applyTransaction(appended);
      }
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
      if (trackerRef.current === entry) {
        trackerRef.current = null;
      }
    };
  }, [editor]);

  useLayoutEffect(() => {
    const entry = trackerRef.current;
    if (sentContent === undefined || !entry || entry.editor.isDestroyed) {
      return;
    }
    entry.tracker.markSent(sentContent, (doc) =>
      serializeEditorDoc(entry.editor, doc),
    );
  }, [sentContent, editor]);

  useLayoutEffect(() => {
    const entry = trackerRef.current;
    if (!entry || entry.editor.isDestroyed) {
      return;
    }
    if (content === mergedContentRef.current) {
      return;
    }
    mergedContentRef.current = content;
    const { editor: ed } = entry;
    try {
      const incoming = parseEditorMarkdown(ed, content);
      const result = entry.tracker.merge(ed.state, incoming);
      if (!result) {
        return;
      }
      ed.view.dispatch(result.tr);
      if (result.conflicted) {
        toast.warning(t("tiptapDocumentEditor.remoteEditConflict"));
      }
      const merged = getEditorMarkdown(ed);
      if (merged !== serializeEditorDoc(ed, incoming)) {
        onMergedRef.current?.(merged);
      }
    } catch (error) {
      captureError(error, { context: "mergeRemoteDocumentContent" });
      ed.commands.setContent(content, { emitUpdate: false });
      entry.tracker = new RemoteMergeTracker(ed.state.doc);
    }
  }, [content, editor, t]);
}
