import { and, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../../../../memory/db.js";
import { enqueueMemoryJob } from "../../../../memory/jobs-store.js";
import { memoryGraphNodes } from "../../../../memory/schema.js";
import { clampUnitInterval } from "../../../../memory/validation.js";
import { extractStylePatterns } from "../../../../messaging/style-analyzer.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { truncate } from "../../../../util/truncate.js";
import { err, getProviderConnection, ok, resolveProvider } from "./shared.js";

/** Map legacy caller kinds to valid MemoryType values. */
const KIND_TO_MEMORY_TYPE: Record<string, string> = {
  style: "behavioral",
  relationship: "semantic",
};

function upsertMemoryItem(opts: {
  kind: string;
  subject: string;
  statement: string;
  importance: number;
  scopeId: string;
}): void {
  const db = getDb();
  const now = Date.now();
  const content = `${opts.subject}\n${opts.statement}`;

  const existing = db
    .select()
    .from(memoryGraphNodes)
    .where(
      and(
        eq(memoryGraphNodes.content, content),
        eq(memoryGraphNodes.scopeId, opts.scopeId),
        sql`${memoryGraphNodes.fidelity} != 'gone'`,
      ),
    )
    .get();

  if (existing) {
    db.update(memoryGraphNodes)
      .set({
        content,
        type: KIND_TO_MEMORY_TYPE[opts.kind] ?? opts.kind,
        fidelity: "vivid",
        significance: clampUnitInterval(
          Math.max(existing.significance ?? 0, opts.importance),
        ),
        lastAccessed: now,
        sourceType: existing.sourceType === "direct" ? "direct" : "inferred",
      })
      .where(eq(memoryGraphNodes.id, existing.id))
      .run();
    enqueueMemoryJob("embed_graph_node", { nodeId: existing.id });
  } else {
    const id = uuid();
    db.insert(memoryGraphNodes)
      .values({
        id,
        content,
        type: KIND_TO_MEMORY_TYPE[opts.kind] ?? opts.kind,
        created: now,
        lastAccessed: now,
        lastConsolidated: now,
        emotionalCharge:
          '{"valence":0,"intensity":0.1,"decayCurve":"linear","decayRate":0.05,"originalIntensity":0.1}',
        fidelity: "vivid",
        confidence: 0.8,
        significance: clampUnitInterval(opts.importance),
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now,
        sourceConversations: "[]",
        sourceType: "inferred",
        narrativeRole: null,
        partOfStory: null,
        scopeId: opts.scopeId,
      })
      .run();
    enqueueMemoryJob("embed_graph_node", { nodeId: id });
  }
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;
  const maxMessages = Math.min(
    Math.max((input.max_messages as number) ?? 50, 1),
    100,
  );
  const queryFilter = input.query_filter as string | undefined;

  try {
    const provider = await resolveProvider(platform);
    const account = input.account as string | undefined;
    const conn = await getProviderConnection(provider, account);
    // Search for sent messages using the platform's search
    const query =
      queryFilter ?? (provider.id === "gmail" ? "in:sent" : "from:me");
    const searchResult = await provider.search(conn, query, {
      count: maxMessages,
    });

    if (searchResult.messages.length === 0) {
      return err(
        "No sent messages found. Send some messages first, then try again.",
      );
    }

    const result = await extractStylePatterns(searchResult.messages);

    if (result.stylePatterns.length === 0) {
      return err("No style patterns were extracted. Try with more messages.");
    }

    const scopeId = context.memoryScopeId ?? "default";
    let savedCount = 0;

    for (const pattern of result.stylePatterns) {
      const subject = `${provider.id} writing style: ${pattern.aspect}`;
      const importance = clampUnitInterval(
        Math.min(0.85, Math.max(0.55, pattern.importance ?? 0.65)),
      );
      upsertMemoryItem({
        kind: "style",
        subject,
        statement: pattern.summary,
        importance,
        scopeId,
      });
      savedCount++;
    }

    for (const contact of result.contactObservations) {
      if (!contact.name || !contact.toneNote) continue;
      const subject = `${provider.id} relationship: ${contact.name}`;
      upsertMemoryItem({
        kind: "relationship",
        subject,
        statement: truncate(
          `${contact.name} (${contact.email}): ${contact.toneNote}`,
          500,
          "",
        ),
        importance: 0.6,
        scopeId,
      });
      savedCount++;
    }

    const aspects = result.stylePatterns.map((p) => p.aspect).join(", ");
    const contactCount = result.contactObservations.length;
    const summary = [
      `Analyzed ${searchResult.messages.length} messages on ${provider.displayName}.`,
      `Extracted ${result.stylePatterns.length} style patterns (${aspects}).`,
      contactCount > 0
        ? `Noted ${contactCount} recurring contact relationship(s).`
        : "",
      `Saved ${savedCount} memory items. Future drafts will automatically reflect your writing style.`,
    ]
      .filter(Boolean)
      .join(" ");

    return ok(summary);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
