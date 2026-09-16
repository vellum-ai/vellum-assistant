/**
 * Tool surface the memory consolidation run is wire-scoped to.
 *
 * Consolidation is a local memory-file reorganization pass: it reads
 * `buffer.md` and the existing pages, writes and edits concept pages, rewrites
 * recent/essentials/threads, and trims the buffer.
 *
 * `bash` carries the corpus-wide inspection the pass leans on: slug and title
 * greps before spawning a page, status-marker counts, size checks against the
 * cap-bound files, frontmatter peeks across a batch of slugs. The run is
 * guardian-trust and non-interactive, so the permission checker's autonomous
 * threshold, not this list, decides which shell commands execute unattended.
 *
 * `delete_memory_page` retires merged, renamed, or dead pages. Unattended `rm`
 * is denied unless the autonomous threshold is Full access, so this slug-scoped
 * tool is the delete path everywhere else. It is allowlist-only (see
 * `ALLOWLIST_ONLY_TOOL_NAMES`), so naming it here is what surfaces it.
 *
 * Network egress and host-proxy tools (`web_fetch`, `web_search`,
 * `network_request`, `host_*`) are excluded: the pass has no use for them.
 *
 * Every name here must resolve onto the wire for a background conversation.
 * `SUBAGENT_ONLY_TOOL_NAMES` (`file_list`, `code_search`) are filtered off
 * before this allowlist applies, so listing one is a silent no-op. The wire
 * resolution is asserted in `daemon/__tests__/conversation-tool-setup.test.ts`.
 */
export const CONSOLIDATION_ALLOWED_TOOLS: readonly string[] = [
  "file_read",
  "file_write",
  "file_edit",
  "bash",
  "delete_memory_page",
  "recall",
];
