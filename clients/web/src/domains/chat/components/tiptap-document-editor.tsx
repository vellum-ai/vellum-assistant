/**
 * Tiptap/ProseMirror-based WYSIWYG document editor React component that supports:
 * - Rich-text editing of markdown content
 * - Floating bubble menu toolbar (block style, marks, lists, quote, link, comment)
 * - An empty-document placeholder
 * - Comment anchor highlight decorations (yellow)
 * - Active/temporary highlight range decorations (blue)
 * - Text selection tracking with character offset conversion
 * - Incoming content merged into local edits (`useTiptapRemoteMerge`)
 */

import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { cn } from "@vellumai/design-library";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { BubbleToolbar } from "@/domains/chat/components/tiptap-bubble-toolbar";
import {
  activeHighlightPluginKey,
  buildDocumentEditorExtensions,
  commentAnchorPluginKey,
  getEditorMarkdown,
} from "@/domains/chat/components/tiptap-editor-extensions";
import { useTiptapRemoteMerge } from "@/domains/chat/hooks/use-tiptap-remote-merge";
import type { CommentAnchor } from "@/domains/chat/utils/tiptap-position-map";
import {
  charOffsetToPmPos,
  pmPosToCharOffset,
} from "@/domains/chat/utils/tiptap-position-map";
import { useTranslation } from "@/i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TiptapDocumentEditorProps {
  /** The body from outside the editor; each change merges into local edits. */
  content: string;
  /** The body the save path last wrote, a merge base for later content. */
  sentContent?: string;
  editable?: boolean;
  onContentChange?: (markdown: string) => void;
  /** A merge of `content` produced a body that still needs saving. */
  onRemoteMerge?: (markdown: string) => void;
  onTextSelect?: (
    selection: {
      start: number;
      end: number;
      text: string;
      rect: DOMRect;
    } | null,
  ) => void;
  commentAnchors?: CommentAnchor[];
  highlightRange?: { start: number; end: number } | null;
  onCommentSubmit?: (comment: string) => void;
  commentSubmitting?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TiptapDocumentEditor({
  content,
  sentContent,
  editable = true,
  onContentChange,
  onRemoteMerge,
  onTextSelect,
  commentAnchors = [],
  highlightRange = null,
  onCommentSubmit,
  commentSubmitting,
  className,
}: TiptapDocumentEditorProps) {
  const onContentChangeRef = useRef(onContentChange);
  useLayoutEffect(() => {
    onContentChangeRef.current = onContentChange;
  });

  const onTextSelectRef = useRef(onTextSelect);
  useLayoutEffect(() => {
    onTextSelectRef.current = onTextSelect;
  });

  const { t } = useTranslation("chat");

  const editor = useEditor({
    extensions: buildDocumentEditorExtensions({
      commentAnchors,
      highlightRange,
      placeholder: t("tiptapDocumentEditor.placeholder"),
    }),
    content,
    editable,
    onUpdate({ editor: ed }) {
      onContentChangeRef.current?.(getEditorMarkdown(ed));
    },
    onSelectionUpdate({ editor: ed }) {
      const { from, to } = ed.state.selection;
      if (from === to) {
        const tr = ed.state.tr.setMeta(activeHighlightPluginKey, {
          range: null,
        });
        ed.view.dispatch(tr);
        onTextSelectRef.current?.(null);
        return;
      }

      const text = ed.state.doc.textBetween(from, to);
      if (!text.trim()) {
        return;
      }

      const start = pmPosToCharOffset(ed.state.doc, from);
      const end = pmPosToCharOffset(ed.state.doc, to);

      const domSelection = ed.view.dom.ownerDocument.getSelection();
      if (!domSelection || domSelection.rangeCount === 0) {
        return;
      }
      const rect = domSelection.getRangeAt(0).getBoundingClientRect();

      onTextSelectRef.current?.({ start, end, text, rect });
    },
  });

  useLayoutEffect(() => {
    editor?.setEditable(editable, false);
  }, [editable, editor]);

  // -------------------------------------------------------------------------
  // Merge content prop → editor as a remote change
  // -------------------------------------------------------------------------

  useTiptapRemoteMerge({
    editor,
    content,
    sentContent,
    onMerged: onRemoteMerge,
  });

  // -------------------------------------------------------------------------
  // Sync commentAnchors prop → decoration plugin
  // -------------------------------------------------------------------------

  const syncAnchors = useCallback(
    (anchors: CommentAnchor[]) => {
      if (!editor) {
        return;
      }
      const tr = editor.state.tr.setMeta(commentAnchorPluginKey, { anchors });
      editor.view.dispatch(tr);
    },
    [editor],
  );

  useEffect(() => {
    syncAnchors(commentAnchors);
  }, [commentAnchors, syncAnchors]);

  // -------------------------------------------------------------------------
  // Sync highlightRange prop → decoration plugin + auto-scroll
  // -------------------------------------------------------------------------

  const syncHighlight = useCallback(
    (range: { start: number; end: number } | null) => {
      if (!editor) {
        return;
      }
      const tr = editor.state.tr.setMeta(activeHighlightPluginKey, { range });
      editor.view.dispatch(tr);

      // Auto-scroll the highlight into view
      if (range) {
        const pos = charOffsetToPmPos(editor.state.doc, range.start);
        const dom = editor.view.domAtPos(pos);
        if (dom.node instanceof HTMLElement) {
          dom.node.scrollIntoView({ behavior: "smooth", block: "center" });
        } else if (dom.node.parentElement) {
          dom.node.parentElement.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }
      }
    },
    [editor],
  );

  useEffect(() => {
    syncHighlight(highlightRange);
  }, [highlightRange, syncHighlight]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className={cn("flex flex-col", className)}>
      <style>{editorStyles}</style>
      <EditorContent
        editor={editor}
        className="flex flex-1 flex-col overflow-y-auto"
      />
      {editor && editable ? (
        <BubbleMenu
          editor={editor}
          updateDelay={100}
          options={BUBBLE_MENU_OPTIONS}
        >
          <BubbleToolbar
            key={`${editor.state.selection.from}-${editor.state.selection.to}`}
            editor={editor}
            onCommentSubmit={onCommentSubmit}
            commentSubmitting={commentSubmitting}
          />
        </BubbleMenu>
      ) : null}
    </div>
  );
}

/** Keep the toolbar off the pane's edges on narrow screens. */
const BUBBLE_MENU_OPTIONS = { shift: { padding: 8 } };

// ---------------------------------------------------------------------------
// Editor styles using design system tokens
// ---------------------------------------------------------------------------

const editorStyles = /* css */ `
  .tiptap {
    font-family: var(--font-body);
    font-size: var(--text-chat-size);
    line-height: var(--text-chat-line-height);
    color: var(--content-default);
    padding: 24px 32px;
    outline: none;
    /* Fill the pane so a click anywhere below short content places the caret. */
    flex: 1 0 auto;
  }
  .tiptap:focus {
    outline: none;
  }
  .tiptap > :first-child { margin-top: 0; }

  .tiptap p.is-editor-empty:first-child::before {
    content: attr(data-placeholder);
    float: left;
    height: 0;
    color: var(--content-tertiary);
    pointer-events: none;
  }

  /* Headings: the title scale, with leading for lines that wrap. */
  .tiptap h1, .tiptap h2, .tiptap h3 {
    font-family: var(--font-sans);
    color: var(--content-emphasised);
  }
  .tiptap h1 {
    font-size: var(--text-title-large-size);
    font-weight: var(--text-title-large-weight);
    line-height: 32px;
    margin: 1.2em 0 0.4em;
  }
  .tiptap h2 {
    font-size: var(--text-title-medium-size);
    font-weight: var(--text-title-medium-weight);
    line-height: 28px;
    margin: 1.1em 0 0.35em;
  }
  .tiptap h3 {
    font-size: var(--text-title-small-size);
    font-weight: 600;
    line-height: 22px;
    margin: 1em 0 0.3em;
  }

  /* Block elements */
  .tiptap p { margin: 0.5em 0; }
  .tiptap ul, .tiptap ol { margin: 0.5em 0; padding-left: 1.5em; }
  .tiptap ul { list-style: disc; }
  .tiptap ol { list-style: decimal; }
  .tiptap ul ul { list-style: circle; }
  .tiptap li { margin: 0.2em 0; }
  .tiptap li > p { margin: 0; }
  .tiptap li::marker { color: var(--content-tertiary); }
  .tiptap blockquote {
    margin: 0.75em 0;
    padding: 0.125em 0 0.125em 1em;
    border-left: 2px solid var(--border-element);
    color: var(--content-secondary);
  }
  .tiptap hr {
    border: none;
    border-top: 1px solid var(--border-base);
    margin: 1.5em 0;
  }

  /* Inline code */
  .tiptap code {
    font-family: var(--font-mono);
    font-size: 0.875em;
    background: var(--surface-active);
    padding: 0.125em 0.375em;
    border-radius: var(--radius-xs);
  }

  /* Code blocks */
  .tiptap pre {
    margin: 0.75em 0;
    padding: 12px 16px;
    background: var(--surface-sunken);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow-x: auto;
  }
  .tiptap pre code {
    background: none;
    padding: 0;
  }

  /* Links */
  .tiptap a {
    color: var(--content-link);
    text-decoration: underline;
    text-decoration-color: var(--content-link-hover);
    text-underline-offset: 2px;
  }
  .tiptap a:hover {
    color: var(--content-link-hover);
  }

  /* Tables */
  .tiptap table {
    border-collapse: collapse;
    margin: 0.75em 0;
    width: 100%;
  }
  .tiptap th, .tiptap td {
    border: 1px solid var(--border-base);
    padding: 6px 10px;
    text-align: left;
  }
  .tiptap th {
    background: var(--surface-sunken);
    font-weight: 600;
  }

  /* Comment anchor highlights */
  .comment-anchor-highlight {
    background-color: var(--system-mid-weak);
    border-bottom: 2px solid var(--system-mid-strong);
    border-radius: 2px;
    cursor: pointer;
    transition: background-color var(--anim-fast) ease;
  }
  .comment-anchor-highlight:hover {
    background-color: color-mix(in srgb, var(--system-mid-strong) 35%, var(--system-mid-weak));
  }

  /* Active/temporary highlight */
  .active-highlight {
    background-color: var(--system-info-weak);
    border-bottom: 2px solid var(--system-info-strong);
    border-radius: 2px;
  }

  .tiptap ::selection {
    background-color: var(--system-info-weak);
  }
`;
