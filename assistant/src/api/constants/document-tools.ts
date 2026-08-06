/**
 * The document tools that mutate the stored document set, and what each one
 * leaves behind. This is the single declaration both the daemon and the web
 * client derive their tool sets from, so a new mutating document tool is added
 * here once and every consumer picks it up.
 *
 * Tool names are the ones the runner sees. Calls arriving through the bundled
 * `document-editor` skill reach the daemon already unwrapped to the inner tool
 * name, and the web client unwraps the `skill_execute` envelope itself.
 */

export interface DocumentMutationTool {
  /** The executed tool name. */
  readonly name: string;
  /**
   * Whether the document is still openable once the tool has run. A deleted
   * document has nothing to open, so it cannot anchor a link back to itself.
   */
  readonly reopenable: boolean;
  /**
   * Whether the tool writes into an already-created document, as opposed to
   * the create that opened it.
   */
  readonly edit: boolean;
}

export const DOCUMENT_MUTATION_TOOLS: readonly DocumentMutationTool[] = [
  { name: "document_create", reopenable: true, edit: false },
  { name: "document_update", reopenable: true, edit: true },
  { name: "document_replace_text", reopenable: true, edit: true },
  { name: "document_delete", reopenable: false, edit: false },
];

/**
 * Every tool that changes the document list. The daemon hooks these to publish
 * a documents-changed broadcast, because they carry no list-level change signal
 * of their own and client asset lists would otherwise keep serving a cached
 * list after an edit and a deleted document would linger as a ghost row.
 */
export const DOCUMENT_MUTATION_TOOL_NAMES: readonly string[] =
  DOCUMENT_MUTATION_TOOLS.map((tool) => tool.name);

/**
 * The mutating tools that leave the document openable. The web transcript
 * anchors its changed-document chips on these, so a delete never produces a
 * chip pointing at a document that is gone.
 */
export const REOPENABLE_DOCUMENT_MUTATION_TOOL_NAMES: readonly string[] =
  DOCUMENT_MUTATION_TOOLS.filter((tool) => tool.reopenable).map(
    (tool) => tool.name,
  );

/** The mutating tools that write into an already-created document. */
export const DOCUMENT_EDIT_TOOL_NAMES: readonly string[] =
  DOCUMENT_MUTATION_TOOLS.filter((tool) => tool.edit).map((tool) => tool.name);
