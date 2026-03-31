import {
  createMailRule,
  deleteMailRule,
  listMailRules,
} from "../../../../messaging/providers/outlook/client.js";
import type {
  OutlookMessageRuleActions,
  OutlookMessageRulePredicates,
} from "../../../../messaging/providers/outlook/types.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const action = input.action as string;

  if (!action) {
    return err("action is required (list, create, or delete).");
  }

  try {
    const connection = await resolveOAuthConnection("outlook", {
      account,
    });
    switch (action) {
      case "list": {
        const resp = await listMailRules(connection);
        const rules = resp.value ?? [];
        if (rules.length === 0) {
          return ok("No inbox rules configured.");
        }
        const summary = rules.map((r) => ({
          id: r.id,
          displayName: r.displayName,
          isEnabled: r.isEnabled,
          conditions: summarizeConditions(r.conditions),
          actions: summarizeActions(r.actions),
        }));
        return ok(JSON.stringify(summary, null, 2));
      }

      case "create": {
        const displayName = input.display_name as string;
        if (!displayName)
          return err("display_name is required for create action.");

        const conditions: OutlookMessageRulePredicates = {};
        if (input.from_contains)
          conditions.senderContains = Array.isArray(input.from_contains)
            ? (input.from_contains as string[])
            : [input.from_contains as string];
        if (input.subject_contains)
          conditions.subjectContains = Array.isArray(input.subject_contains)
            ? (input.subject_contains as string[])
            : [input.subject_contains as string];
        if (input.body_contains)
          conditions.bodyContains = Array.isArray(input.body_contains)
            ? (input.body_contains as string[])
            : [input.body_contains as string];
        if (input.has_attachment !== undefined)
          conditions.hasAttachments = input.has_attachment as boolean;
        if (input.importance)
          conditions.importance = input.importance as "low" | "normal" | "high";

        if (Object.keys(conditions).length === 0) {
          return err(
            "At least one condition is required (from_contains, subject_contains, body_contains, has_attachment, or importance).",
          );
        }

        const actions: OutlookMessageRuleActions = {};
        if (input.move_to_folder)
          actions.moveToFolder = input.move_to_folder as string;
        if (input.delete !== undefined)
          actions.delete = input.delete as boolean;
        if (input.mark_as_read !== undefined)
          actions.markAsRead = input.mark_as_read as boolean;
        if (input.mark_importance)
          actions.markImportance = input.mark_importance as
            | "low"
            | "normal"
            | "high";
        if (input.forward_to) {
          const emails = Array.isArray(input.forward_to)
            ? (input.forward_to as string[])
            : [input.forward_to as string];
          actions.forwardTo = emails.map((addr) => ({
            emailAddress: { address: addr },
          }));
        }
        if (input.stop_processing !== undefined)
          actions.stopProcessingRules = input.stop_processing as boolean;

        const rule = await createMailRule(connection, {
          displayName,
          sequence: (input.sequence as number) ?? 1,
          isEnabled: true,
          conditions,
          actions,
        });
        return ok(`Rule created (ID: ${rule.id}).`);
      }

      case "delete": {
        const ruleId = input.rule_id as string;
        if (!ruleId) return err("rule_id is required for delete action.");

        await deleteMailRule(connection, ruleId);
        return ok("Rule deleted.");
      }

      default:
        return err(`Unknown action "${action}". Use list, create, or delete.`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

function summarizeConditions(
  c: OutlookMessageRulePredicates | undefined,
): string {
  if (!c) return "none";
  const parts: string[] = [];
  if (c.senderContains?.length)
    parts.push(`sender contains: ${c.senderContains.join(", ")}`);
  if (c.subjectContains?.length)
    parts.push(`subject contains: ${c.subjectContains.join(", ")}`);
  if (c.bodyContains?.length)
    parts.push(`body contains: ${c.bodyContains.join(", ")}`);
  if (c.fromAddresses?.length)
    parts.push(
      `from: ${c.fromAddresses.map((a) => a.emailAddress.address).join(", ")}`,
    );
  if (c.hasAttachments !== undefined)
    parts.push(`has attachments: ${c.hasAttachments}`);
  if (c.importance) parts.push(`importance: ${c.importance}`);
  return parts.length > 0 ? parts.join("; ") : "none";
}

function summarizeActions(c: OutlookMessageRuleActions | undefined): string {
  if (!c) return "none";
  const parts: string[] = [];
  if (c.moveToFolder) parts.push(`move to folder: ${c.moveToFolder}`);
  if (c.delete) parts.push("delete");
  if (c.markAsRead) parts.push("mark as read");
  if (c.markImportance) parts.push(`mark importance: ${c.markImportance}`);
  if (c.forwardTo?.length)
    parts.push(
      `forward to: ${c.forwardTo.map((r) => r.emailAddress.address).join(", ")}`,
    );
  if (c.stopProcessingRules) parts.push("stop processing rules");
  return parts.length > 0 ? parts.join("; ") : "none";
}
