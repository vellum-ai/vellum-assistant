/**
 * Default `memory` message-persisted hook.
 *
 * Feeds each persisted transcript-visible message into the memory feature's
 * segment indexing / extraction pipeline ({@link indexMessageNow}) — the
 * entry point that chunks the message into memory segments, enqueues
 * embedding jobs, and (for trusted actors) triggers graph extraction.
 *
 * Only the plain persist path dispatches this hook; the direct write seams
 * (streaming reserve+finalize, conversation import) call `indexMessageNow`
 * themselves after finalizing their content.
 */

import type {
  HookFunction,
  MessagePersistedContext,
} from "@vellumai/plugin-api";

import { getMemoryConfig } from "../config.js";
import { indexMessageNow } from "../indexer.js";

const messagePersisted: HookFunction<MessagePersistedContext> = async (ctx) => {
  await indexMessageNow(
    {
      messageId: ctx.messageId,
      conversationId: ctx.conversationId,
      role: ctx.role,
      content: ctx.content,
      createdAt: ctx.createdAt,
      // `null` means the persisting path recorded no provenance (legacy rows,
      // internal writers); the indexer's trust gate treats absent as trusted.
      provenanceTrustClass: ctx.provenanceTrustClass ?? undefined,
      automated: ctx.automated,
      scopeId: "default",
    },
    getMemoryConfig(),
  );
};

export default messagePersisted;
