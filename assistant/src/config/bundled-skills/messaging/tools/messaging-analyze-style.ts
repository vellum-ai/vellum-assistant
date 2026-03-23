import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../../../../memory/db.js";
import { computeMemoryFingerprint } from "../../../../memory/fingerprint.js";
import { enqueueMemoryJob } from "../../../../memory/jobs-store.js";
import { memoryItems } from "../../../../memory/schema.js";
import { clampUnitInterval } from "../../../../memory/validation.js";
import { extractStylePatterns } from "../../../../messaging/style-analyzer.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { truncate } from "../../../../util/truncate.js";
import { err, getProviderConnection, ok, resolveProvider } from "./shared.js";

function upsertMemoryItem(opts: {
  kind: string;
  subject: string;
  statement: string;
  importance: number;
  scopeId: string;
}): void {
  const db = getDb();
  const now = Date.now();
  const fingerprint = computeMemoryFingerprint(
    opts.scopeId,
    opts.kind,
    opts.subject,
    opts.statement,
  );

  const existing = db
    .select()
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.fingerprint, fingerprint),
        eq(memoryItems.scopeId, opts.scopeId),
      ),
    )
    .get();

  if (existing) {
    db.update(memoryItems)
      .set({
        statement: opts.statement,
        status: "active",
        importance: clampUnitInterval(
          Math.max(existing.importance ?? 0, opts.importance),
        ),
        lastSeenAt: now,
        sourceType: "extraction",
      })
      .where(eq(memoryItems.id, existing.id))
      .run();
    enqueueMemoryJob("embed_item", { itemId: existing.id });
  } else {
    const id = uuid();
    db.insert(memoryItems)
      .values({
        id,
        kind: opts.kind,
        subject: opts.subject,
        statement: opts.statement,
        status: "active",
        confidence: 0.8,
        importance: clampUnitInterval(opts.importance),
        fingerprint,
        sourceType: "extraction",
        scopeId: opts.scopeId,
        firstSeenAt: now,
        lastSeenAt: now,
        lastUsedAt: null,
      })
      .run();
    enqueueMemoryJob("embed_item", { itemId: id });
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
