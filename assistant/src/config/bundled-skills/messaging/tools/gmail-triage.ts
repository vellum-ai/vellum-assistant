import {
  type ClassifiedEmail,
  classifyEmails,
  type EmailMetadata,
} from "../../../../messaging/email-classifier.js";
import {
  batchGetMessages,
  batchModifyMessages,
  createLabel,
  listLabels,
  listMessages,
} from "../../../../messaging/providers/gmail/client.js";
import { getMessagingProvider } from "../../../../messaging/registry.js";
import { withValidToken } from "../../../../security/token-manager.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

const FOLLOW_UP_LABEL_NAME = "Follow-up";

async function getOrCreateLabel(token: string, name: string): Promise<string> {
  const labels = await listLabels(token);
  const existing = labels.find((l) => l.name === name);
  if (existing) return existing.id;
  const created = await createLabel(token, name);
  return created.id;
}

function groupByCategory(
  classifications: ClassifiedEmail[],
): Record<string, ClassifiedEmail[]> {
  const groups: Record<string, ClassifiedEmail[]> = {};
  for (const c of classifications) {
    (groups[c.category] ??= []).push(c);
  }
  return groups;
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const maxResults = (input.max_results as number) ?? 20;
  const autoApply = (input.auto_apply as boolean) ?? false;
  const query = (input.query as string) ?? "is:unread in:inbox";

  try {
    const provider = getMessagingProvider("gmail");
    return withValidToken(provider.credentialService, async (token) => {
      const listResp = await listMessages(token, query, maxResults);
      const messageIds = (listResp.messages ?? []).map((m) => m.id);

      if (messageIds.length === 0) {
        return ok("No messages to triage.");
      }

      const messages = await batchGetMessages(token, messageIds, "metadata", [
        "From",
        "Subject",
      ]);
      const emailMetadata: EmailMetadata[] = messages.map((m) => {
        const headers = m.payload?.headers ?? [];
        return {
          id: m.id,
          from:
            headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "",
          subject:
            headers.find((h) => h.name.toLowerCase() === "subject")?.value ??
            "",
          snippet: m.snippet ?? "",
          labels: m.labelIds ?? [],
        };
      });

      const result = await classifyEmails(emailMetadata);

      if (result.classifications.length === 0) {
        return ok("Classification unavailable. Try again later.");
      }

      const groups = groupByCategory(result.classifications);
      const actions: string[] = [];

      if (autoApply) {
        // Archive can_archive emails
        const archivable = groups["can_archive"] ?? [];
        if (archivable.length > 0) {
          await batchModifyMessages(
            token,
            archivable.map((c) => c.id),
            { removeLabelIds: ["INBOX"] },
          );
          actions.push(`Archived ${archivable.length} message(s)`);
        }

        // Label needs_reply as Follow-up
        const needsReply = groups["needs_reply"] ?? [];
        if (needsReply.length > 0) {
          const followUpLabelId = await getOrCreateLabel(
            token,
            FOLLOW_UP_LABEL_NAME,
          );
          await batchModifyMessages(
            token,
            needsReply.map((c) => c.id),
            { addLabelIds: [followUpLabelId] },
          );
          actions.push(`Labeled ${needsReply.length} message(s) as Follow-up`);
        }
      }

      const report = {
        total: result.classifications.length,
        groups: Object.fromEntries(
          Object.entries(groups).map(([cat, items]) => [
            cat,
            items.map((c) => ({
              id: c.id,
              reasoning: c.reasoning,
              suggestedAction: c.suggestedAction,
              urgencyScore: c.urgencyScore,
            })),
          ]),
        ),
        actionsApplied: actions,
      };

      return ok(JSON.stringify(report, null, 2));
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
