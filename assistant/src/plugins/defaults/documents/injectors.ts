/**
 * `documents` plugin injectors.
 *
 * Contributes the open-document per-turn injections: the `<active_documents>`
 * list (so the assistant edits existing documents instead of duplicating them)
 * and `<document_comments>` (open comments to address). Both read the open
 * documents off the {@link TurnContext}; see {@link DEFAULT_INJECTOR_ORDER} for
 * the global ordering contract.
 */

import { listComments } from "../../../documents/document-comments-store.js";
import {
  type InjectionBlock,
  type Injector,
  type TurnContext,
} from "../../types.js";
import { DEFAULT_INJECTOR_ORDER } from "../injector-order.js";

/**
 * `active-documents` injector — order 45, prepend-user-tail.
 *
 * Injects an `<active_documents>` block listing open documents in the
 * conversation so the assistant can target them with `document_update`
 * instead of creating duplicates via `document_create`.
 *
 * Gating:
 *  - `mode === "full"`.
 *  - `activeDocuments` has at least one entry.
 */
const activeDocumentsInjector: Injector = {
  name: "active-documents",
  order: DEFAULT_INJECTOR_ORDER.activeDocuments,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const mode = ctx.mode ?? "full";
    if (mode !== "full") return null;
    const docs = ctx.activeDocuments;
    if (!docs || docs.length === 0) return null;
    const lines = docs.map(
      (d) =>
        `- surface_id: "${d.surfaceId}", title: "${d.title}", words: ${d.wordCount}`,
    );
    const text = `<active_documents>\nThe following documents are open in this conversation. Use document_update with the surface_id to edit them — do NOT call document_create for documents that already exist.\n${lines.join("\n")}\n</active_documents>`;
    return {
      id: "active-documents",
      text,
      placement: "prepend-user-tail",
    };
  },
};

/** Maximum open comments surfaced per document to limit context bloat. */
const DOCUMENT_COMMENTS_CAP = 10;

/**
 * Escape closing `</document_comments>` inside user-controlled strings so
 * they cannot break out of the XML wrapper — same pattern as the
 * `<knowledge_base>` and `<info>` memory blocks.
 */
function escapeDocCommentTag(s: string): string {
  return s.replace(/<\/document_comments\s*>/gi, "&lt;/document_comments&gt;");
}

/**
 * `document-comments` injector — order 46, prepend-user-tail.
 *
 * Surfaces open top-level comments on active documents so the assistant
 * knows what feedback to address. For each active document, queries the
 * comment store for open top-level comments (capped at
 * {@link DOCUMENT_COMMENTS_CAP} most recent per document). Inline comments
 * include the quoted anchor text; doc-level comments are labelled as such.
 *
 * Gating:
 *  - `mode === "full"`.
 *  - `activeDocuments` has at least one entry.
 *  - At least one document has open comments (returns null otherwise).
 */
const documentCommentsInjector: Injector = {
  name: "document-comments",
  order: DEFAULT_INJECTOR_ORDER.documentComments,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const mode = ctx.mode ?? "full";
    if (mode !== "full") return null;
    const docs = ctx.activeDocuments;
    if (!docs || docs.length === 0) return null;

    const sections: string[] = [];
    for (const doc of docs) {
      const comments = listComments(doc.surfaceId, {
        status: "open",
        topLevelOnly: true,
      }).slice(-DOCUMENT_COMMENTS_CAP);
      if (comments.length === 0) continue;

      const lines = comments.map((c) => {
        const anchor =
          c.anchorText != null ? escapeDocCommentTag(c.anchorText) : null;
        const label =
          anchor != null ? `inline, anchored to "${anchor}"` : "doc-level";
        return `- Comment #${c.id} (${label}): "${escapeDocCommentTag(c.content)}"`;
      });
      sections.push(
        `Document: "${escapeDocCommentTag(doc.title)}" (surface_id: "${doc.surfaceId}")\n${lines.join("\n")}`,
      );
    }

    if (sections.length === 0) return null;

    const text = `<document_comments>
Open comments on your documents. Address these by editing the document, then use comment_resolve to mark each resolved.

${sections.join("\n\n")}
</document_comments>`;
    return {
      id: "document-comments",
      text,
      placement: "prepend-user-tail",
    };
  },
};

/** The `documents` plugin's runtime injectors, in ascending `order`. */
export const documentsInjectors: Injector[] = [
  activeDocumentsInjector,
  documentCommentsInjector,
];
