/**
 * Tiptap extension configuration for the document editor, shared between the
 * React component and headless usage (tests). Includes the decoration
 * extensions for comment anchors and the active highlight range.
 */

import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";

import type { CommentAnchor } from "@/domains/chat/utils/tiptap-position-map";
import { charOffsetToPmPos } from "@/domains/chat/utils/tiptap-position-map";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the current markdown from a tiptap editor with the Markdown extension. */
export function getEditorMarkdown(editor: Editor): string {
  const storage = editor.storage as unknown as { markdown: MarkdownStorage };
  return storage.markdown.getMarkdown();
}

// ---------------------------------------------------------------------------
// Decoration plugin keys
// ---------------------------------------------------------------------------

export const commentAnchorPluginKey = new PluginKey("commentAnchorHighlights");
export const activeHighlightPluginKey = new PluginKey("activeHighlight");

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
  if (!range) {
    return DecorationSet.empty;
  }

  const from = charOffsetToPmPos(doc, range.start);
  const to = charOffsetToPmPos(doc, range.end);
  if (from >= to) {
    return DecorationSet.empty;
  }

  return DecorationSet.create(doc, [
    Decoration.inline(from, to, {
      class: "active-highlight",
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Extension list
// ---------------------------------------------------------------------------

/**
 * The full extension list for the document editor. Table nodes are required:
 * tiptap-markdown parses GFM pipe tables into <table> HTML, and without table
 * nodes in the schema ProseMirror drops the structure and flattens cell text
 * into paragraphs (corrupting the file on the next save).
 */
export function buildDocumentEditorExtensions(
  opts: {
    commentAnchors?: CommentAnchor[];
    highlightRange?: { start: number; end: number } | null;
  } = {},
) {
  return [
    StarterKit,
    Link.configure({ openOnClick: false }),
    Table,
    TableRow,
    TableHeader,
    TableCell,
    Markdown,
    CommentAnchorHighlightExtension.configure({
      anchors: opts.commentAnchors ?? [],
    }),
    ActiveHighlightExtension.configure({ range: opts.highlightRange ?? null }),
  ];
}
