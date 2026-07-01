/**
 * Shared lexical candidate helper for message-content search.
 *
 * Encodes a free-text query with the local TF-IDF sparse encoder and queries
 * the BM25-style sparse Qdrant lexical index (`messages_lexical`) for matching
 * message ids. This is the single entry point the message-search read sites use
 * when the `messages-search-backend` flag selects `qdrant`, mirroring the
 * candidate set SQLite FTS5 would return.
 */

import { generateSparseEmbedding } from "./embeddings/embedding-backend.js";
import {
  getMessagesLexicalIndex,
  type MessageLexicalSearchResult,
} from "./embeddings/messages-lexical-index.js";

/**
 * Resolve message-id candidates for `query` from the Qdrant lexical index,
 * ranked by sparse similarity score (highest first).
 *
 * @param query          free-text search query
 * @param limit          maximum number of candidates to return
 * @param opts.conversationId  restrict results to a single conversation
 */
export async function searchMessageIdsLexical(
  query: string,
  limit: number,
  opts?: { conversationId?: string },
): Promise<MessageLexicalSearchResult[]> {
  const sparse = generateSparseEmbedding(query);
  // A query that tokenizes to nothing (whitespace/punctuation-only) yields an
  // empty sparse vector; matching the FTS paths and other sparse callers,
  // return no candidates without querying Qdrant on an empty vector.
  if (sparse.indices.length === 0) return [];
  return getMessagesLexicalIndex().searchLexical(sparse, limit, opts);
}
