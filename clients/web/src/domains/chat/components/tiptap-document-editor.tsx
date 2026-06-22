/**
 * Tiptap/ProseMirror-based WYSIWYG document editor React component that supports:
 * - Rich-text editing of markdown content
 * - Floating bubble menu toolbar (bold, italic, strike, code, link)
 * - Comment anchor highlight decorations (yellow)
 * - Active/temporary highlight range decorations (blue)
 * - Text selection tracking with character offset conversion
 */

import { Extension } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { cn } from "@vellumai/design-library";
import {
    Bold,
    Code,
    Italic,
    Link as LinkIcon,
    MessageSquareText,
    Strikethrough,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";

import type { CommentAnchor } from "@/domains/chat/utils/tiptap-position-map";
import {
    charOffsetToPmPos,
    pmPosToCharOffset,
} from "@/domains/chat/utils/tiptap-position-map";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TiptapDocumentEditorProps {
  content: string;
  editable?: boolean;
  onContentChange?: (markdown: string) => void;
  onTextSelect?: (selection: {
    start: number;
    end: number;
    text: string;
    rect: DOMRect;
  } | null) => void;
  commentAnchors?: CommentAnchor[];
  highlightRange?: { start: number; end: number } | null;
  onCommentSubmit?: (comment: string) => void;
  commentSubmitting?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the current markdown from a tiptap editor with the Markdown extension. */
function getEditorMarkdown(editor: import("@tiptap/core").Editor): string {
  const storage = editor.storage as unknown as { markdown: MarkdownStorage };
  return storage.markdown.getMarkdown();
}

// ---------------------------------------------------------------------------
// Decoration plugin keys
// ---------------------------------------------------------------------------

const commentAnchorPluginKey = new PluginKey("commentAnchorHighlights");
const activeHighlightPluginKey = new PluginKey("activeHighlight");

// ---------------------------------------------------------------------------
// Comment anchor decoration extension
// ---------------------------------------------------------------------------

const CommentAnchorHighlightExtension = Extension.create<{
  anchors: CommentAnchor[];
}>({
  name: "commentAnchorHighlight",

  addOptions() {
    return { anchors: [] };
  },

  addProseMirrorPlugins() {
    const { anchors } = this.options;
    return [
      new Plugin({
        key: commentAnchorPluginKey,
        state: {
          init(_, { doc }) {
            return buildCommentDecorations(doc, anchors);
          },
          apply(tr, oldDecorations) {
            const meta = tr.getMeta(commentAnchorPluginKey);
            if (meta) {
              return buildCommentDecorations(tr.doc, meta.anchors);
            }
            if (tr.docChanged) {
              return oldDecorations.map(tr.mapping, tr.doc);
            }
            return oldDecorations;
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

function buildCommentDecorations(
  doc: import("@tiptap/pm/model").Node,
  anchors: CommentAnchor[],
): DecorationSet {
  const decorations: Decoration[] = [];

  for (const anchor of anchors) {
    const from = charOffsetToPmPos(doc, anchor.anchorStart);
    const to = charOffsetToPmPos(doc, anchor.anchorEnd);
    if (from < to) {
      decorations.push(
        Decoration.inline(from, to, {
          class: "comment-anchor-highlight",
        }),
      );
    }
  }

  return DecorationSet.create(doc, decorations);
}

// ---------------------------------------------------------------------------
// Active highlight decoration extension
// ---------------------------------------------------------------------------

const ActiveHighlightExtension = Extension.create<{
  range: { start: number; end: number } | null;
}>({
  name: "activeHighlight",

  addOptions() {
    return { range: null };
  },

  addProseMirrorPlugins() {
    const { range } = this.options;
    return [
      new Plugin({
        key: activeHighlightPluginKey,
        state: {
          init(_, { doc }) {
            return buildActiveHighlightDecorations(doc, range);
          },
          apply(tr, oldDecorations) {
            const meta = tr.getMeta(activeHighlightPluginKey);
            if (meta) {
              return buildActiveHighlightDecorations(tr.doc, meta.range);
            }
            if (tr.docChanged) {
              return oldDecorations.map(tr.mapping, tr.doc);
            }
            return oldDecorations;
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

function buildActiveHighlightDecorations(
  doc: import("@tiptap/pm/model").Node,
  range: { start: number; end: number } | null,
): DecorationSet {
  if (!range) return DecorationSet.empty;

  const from = charOffsetToPmPos(doc, range.start);
  const to = charOffsetToPmPos(doc, range.end);
  if (from >= to) return DecorationSet.empty;

  return DecorationSet.create(doc, [
    Decoration.inline(from, to, {
      class: "active-highlight",
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Bubble toolbar sub-component
// ---------------------------------------------------------------------------

interface BubbleToolbarProps {
  editor: ReturnType<typeof useEditor> & object;
  onCommentSubmit?: (comment: string) => void;
  commentSubmitting?: boolean;
}

function BubbleToolbar({ editor, onCommentSubmit, commentSubmitting }: BubbleToolbarProps) {
  const [commentOpen, setCommentOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const toggleComment = useCallback(() => {
    setCommentOpen((prev) => {
      const opening = !prev;
      if (opening && editor) {
        const { from, to } = editor.state.selection;
        if (from !== to) {
          const tr = editor.state.tr.setMeta(activeHighlightPluginKey, {
            range: {
              start: pmPosToCharOffset(editor.state.doc, from),
              end: pmPosToCharOffset(editor.state.doc, to),
            },
          });
          editor.view.dispatch(tr);
        }
      } else if (editor) {
        const tr = editor.state.tr.setMeta(activeHighlightPluginKey, { range: null });
        editor.view.dispatch(tr);
      }
      return opening;
    });
  }, [editor]);

  if (!editor) return null;

  const btnBase = cn(
    "h-7 w-7 rounded-md flex items-center justify-center",
    "text-[var(--content-secondary)]",
    "hover:bg-[var(--surface-hover)] hover:text-[var(--content-emphasised)]",
    "transition-colors",
  );
  const btnActive = cn(
    "bg-[var(--surface-active)] text-[var(--content-emphasised)]",
  );

  type MarkName = "bold" | "italic" | "strike" | "code" | "link";

  const buttons: {
    name: MarkName;
    icon: ReactNode;
    action: () => void;
    separator?: boolean;
  }[] = [
    {
      name: "bold",
      icon: <Bold size={14} />,
      action: () => editor.chain().focus().toggleBold().run(),
    },
    {
      name: "italic",
      icon: <Italic size={14} />,
      action: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      name: "strike",
      icon: <Strikethrough size={14} />,
      action: () => editor.chain().focus().toggleStrike().run(),
      separator: true,
    },
    {
      name: "code",
      icon: <Code size={14} />,
      action: () => editor.chain().focus().toggleCode().run(),
      separator: true,
    },
    {
      name: "link",
      icon: <LinkIcon size={14} />,
      action: () => {
        if (editor.isActive("link")) {
          editor.chain().focus().unsetLink().run();
        } else {
          const url = window.prompt("Enter URL:");
          if (url) {
            editor.chain().focus().setLink({ href: url }).run();
          }
        }
      },
    },
  ];

  const handleSubmitComment = () => {
    if (!draft.trim() || commentSubmitting) return;
    onCommentSubmit?.(draft.trim());
    setDraft("");
    setCommentOpen(false);
    if (editor) {
      const tr = editor.state.tr.setMeta(activeHighlightPluginKey, { range: null });
      editor.view.dispatch(tr);
    }
  };

  return (
    <div
      className={cn(
        "bg-[var(--surface-lift)] rounded-lg",
        "shadow-[var(--shadow-popover)]",
        "border border-[var(--border-base)]",
      )}
    >
      <div className="p-1 flex items-center gap-0.5">
        {buttons.map((btn, i) => (
          <span key={btn.name} className="contents">
            {i > 0 && buttons[i - 1]?.separator && (
              <span className="mx-0.5 h-4 w-px bg-[var(--border-base)]" />
            )}
            <button
              type="button"
              className={cn(btnBase, editor.isActive(btn.name) && btnActive)}
              onClick={btn.action}
              aria-label={btn.name}
              aria-pressed={editor.isActive(btn.name)}
            >
              {btn.icon}
            </button>
          </span>
        ))}
        {onCommentSubmit ? (
          <>
            <span className="mx-0.5 h-4 w-px bg-[var(--border-base)]" />
            <button
              type="button"
              className={cn(btnBase, commentOpen && btnActive)}
              onClick={toggleComment}
              aria-label="Comment"
              aria-pressed={commentOpen}
            >
              <MessageSquareText size={14} />
            </button>
          </>
        ) : null}
      </div>
      {commentOpen ? (
        <div className="w-64 border-t border-[var(--border-base)] p-2">
          <textarea
            className="w-full resize-none rounded-md border border-[var(--field-border)] bg-[var(--field-bg)] px-3 py-2 text-body-medium-lighter text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none transition-[border-color] duration-150 ease-out focus-visible:border-[var(--border-active)]"
            rows={2}
            placeholder="Add your feedback…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmitComment();
              }
            }}
            autoFocus
          />
          <div className="mt-1.5 flex justify-end">
            <button
              type="button"
              className={cn(
                "rounded-md px-2.5 py-1 text-label-medium-default transition-colors",
                draft.trim() && !commentSubmitting
                  ? "bg-[var(--primary-base)] text-[var(--content-inset)] hover:opacity-90"
                  : "bg-[var(--surface-active)] text-[var(--content-disabled)] cursor-not-allowed",
              )}
              onClick={handleSubmitComment}
              disabled={commentSubmitting || !draft.trim()}
            >
              {commentSubmitting ? "Adding…" : "Comment"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TiptapDocumentEditor({
  content,
  editable = true,
  onContentChange,
  onTextSelect,
  commentAnchors = [],
  highlightRange = null,
  onCommentSubmit,
  commentSubmitting,
  className,
}: TiptapDocumentEditorProps) {
  const onContentChangeRef = useRef(onContentChange);
  useLayoutEffect(() => { onContentChangeRef.current = onContentChange; });

  const onTextSelectRef = useRef(onTextSelect);
  useLayoutEffect(() => { onTextSelectRef.current = onTextSelect; });

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // History is included in StarterKit
      }),
      Link.configure({ openOnClick: false }),
      Markdown,
      CommentAnchorHighlightExtension.configure({ anchors: commentAnchors }),
      ActiveHighlightExtension.configure({ range: highlightRange }),
    ],
    content,
    editable,
    onUpdate({ editor: ed }) {
      onContentChangeRef.current?.(getEditorMarkdown(ed));
    },
    onSelectionUpdate({ editor: ed }) {
      const { from, to } = ed.state.selection;
      if (from === to) {
        const tr = ed.state.tr.setMeta(activeHighlightPluginKey, { range: null });
        ed.view.dispatch(tr);
        onTextSelectRef.current?.(null);
        return;
      }

      const text = ed.state.doc.textBetween(from, to);
      if (!text.trim()) return;

      const start = pmPosToCharOffset(ed.state.doc, from);
      const end = pmPosToCharOffset(ed.state.doc, to);

      const domSelection = ed.view.dom.ownerDocument.getSelection();
      if (!domSelection || domSelection.rangeCount === 0) return;
      const rect = domSelection.getRangeAt(0).getBoundingClientRect();

      onTextSelectRef.current?.({ start, end, text, rect });
    },
  });

  // -------------------------------------------------------------------------
  // Sync content prop → editor (only when externally changed)
  // -------------------------------------------------------------------------

  const prevContentRef = useRef(content);

  useEffect(() => {
    if (!editor) return;
    if (content === prevContentRef.current) return;
    prevContentRef.current = content;

    const currentMd = getEditorMarkdown(editor);
    if (currentMd === content) return; // avoid cursor-reset loops

    editor.commands.setContent(content);
  }, [content, editor]);

  // -------------------------------------------------------------------------
  // Sync commentAnchors prop → decoration plugin
  // -------------------------------------------------------------------------

  const syncAnchors = useCallback(
    (anchors: CommentAnchor[]) => {
      if (!editor) return;
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
      if (!editor) return;
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
      <EditorContent editor={editor} className="flex-1 overflow-y-auto" />
      {editor ? (
        <BubbleMenu editor={editor} updateDelay={100}>
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

// ---------------------------------------------------------------------------
// Editor styles using design system tokens
// ---------------------------------------------------------------------------

const editorStyles = /* css */ `
  .tiptap {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.65;
    color: var(--content-default, #1a1a1a);
    padding: 24px 32px;
    outline: none;
  }
  .tiptap:focus {
    outline: none;
  }

  /* Headings */
  .tiptap h1 { font-size: 1.6em; font-weight: 700; margin: 0.8em 0 0.4em; }
  .tiptap h2 { font-size: 1.3em; font-weight: 600; margin: 0.7em 0 0.35em; }
  .tiptap h3 { font-size: 1.1em; font-weight: 600; margin: 0.6em 0 0.3em; }

  /* Block elements */
  .tiptap p { margin: 0.5em 0; }
  .tiptap ul, .tiptap ol { margin: 0.5em 0 0.5em 1.5em; }
  .tiptap li { margin: 0.2em 0; }
  .tiptap blockquote {
    margin: 0.5em 0;
    padding: 0.5em 1em;
    border-left: 3px solid var(--border-base, #d0d0d0);
    color: var(--content-secondary, #555);
  }
  .tiptap hr {
    border: none;
    border-top: 1px solid var(--border-base, #d0d0d0);
    margin: 1em 0;
  }

  /* Inline code */
  .tiptap code {
    font-family: "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
    background: var(--surface-base, #f0f0f0);
    padding: 0.15em 0.35em;
    border-radius: 3px;
  }

  /* Code blocks */
  .tiptap pre {
    margin: 0.5em 0;
    padding: 12px 16px;
    background: var(--surface-base, #f5f5f5);
    border-radius: 6px;
    overflow-x: auto;
  }
  .tiptap pre code {
    background: none;
    padding: 0;
  }

  /* Links */
  .tiptap a {
    color: #2563eb;
    text-decoration: none;
  }
  .tiptap a:hover {
    text-decoration: underline;
  }

  /* Tables */
  .tiptap table {
    border-collapse: collapse;
    margin: 0.5em 0;
    width: 100%;
  }
  .tiptap th, .tiptap td {
    border: 1px solid var(--border-base, #ddd);
    padding: 6px 10px;
    text-align: left;
  }
  .tiptap th {
    background: var(--surface-base, #f9f9f9);
    font-weight: 600;
  }

  /* Comment anchor highlights */
  .comment-anchor-highlight {
    background-color: rgba(255, 213, 79, 0.35);
    border-bottom: 2px solid rgba(255, 167, 38, 0.6);
    border-radius: 2px;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .comment-anchor-highlight:hover {
    background-color: rgba(255, 213, 79, 0.55);
  }

  /* Active/temporary highlight */
  .active-highlight {
    background-color: rgba(66, 165, 245, 0.35);
    border-bottom: 2px solid rgba(33, 150, 243, 0.7);
    border-radius: 2px;
  }

  /* Selection color */
  .tiptap ::selection {
    background-color: rgba(66, 165, 245, 0.3);
  }
`;
