/**
 * IPC route definitions for trust rule CRUD.
 *
 * Exposes gateway-owned trust rule operations to the assistant daemon
 * over the IPC socket. Mirrors the HTTP REST endpoints in
 * `http/routes/trust-rules.ts` but over the newline-delimited JSON
 * protocol — no HTTP auth required.
 */

import { z } from "zod";

import type { TrustDecision } from "@vellumai/ces-contracts/trust-rules";
import { SCOPED_TOOLS } from "@vellumai/ces-contracts/trust-rules";

import {
  addRule,
  getAllRules,
  updateRule,
  removeRule,
  clearRules,
  findHighestPriorityRule,
  findMatchingRule,
  acceptStarterBundle,
} from "../trust-store.js";
import type { IpcRoute } from "./server.js";

const SCOPED_TOOLS_SET: ReadonlySet<string> = new Set(SCOPED_TOOLS);

// ── Schemas ──────────────────────────────────────────────────────────────────

const AddRuleSchema = z.object({
  tool: z.string().min(1),
  pattern: z.string().min(1),
  scope: z.string().optional(),
  decision: z.enum(["allow", "deny", "ask"]).optional(),
  priority: z.number().finite().optional(),
  executionTarget: z.string().optional(),
});

const UpdateRuleSchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1).optional(),
  pattern: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  decision: z.enum(["allow", "deny", "ask"]).optional(),
  priority: z.number().finite().optional(),
});

const RemoveRuleSchema = z.object({
  id: z.string().min(1),
});

const MatchRuleSchema = z.object({
  tool: z.string().min(1),
  scope: z.string().min(1),
  // Single pattern match
  pattern: z.string().optional(),
  // Multi-command highest priority match
  commands: z.array(z.string()).optional(),
});

// ── Routes ───────────────────────────────────────────────────────────────────

export const trustRuleRoutes: IpcRoute[] = [
  {
    method: "list_trust_rules",
    handler: () => {
      return { rules: getAllRules() };
    },
  },

  {
    method: "add_trust_rule",
    schema: AddRuleSchema,
    handler: (params?: Record<string, unknown>) => {
      const p = params as z.infer<typeof AddRuleSchema>;
      const isScoped = SCOPED_TOOLS_SET.has(p.tool);
      const effectiveScope =
        isScoped && p.scope ? p.scope : p.scope || "everywhere";

      const rule = addRule(
        p.tool,
        p.pattern,
        effectiveScope,
        (p.decision as TrustDecision) ?? "allow",
        p.priority ?? 100,
        p.executionTarget != null
          ? { executionTarget: p.executionTarget }
          : undefined,
      );
      return { rule };
    },
  },

  {
    method: "update_trust_rule",
    schema: UpdateRuleSchema,
    handler: (params?: Record<string, unknown>) => {
      const p = params as z.infer<typeof UpdateRuleSchema>;
      const rule = updateRule(p.id, {
        tool: p.tool,
        pattern: p.pattern,
        scope: p.scope,
        decision: p.decision as TrustDecision | undefined,
        priority: p.priority,
      });
      return { rule };
    },
  },

  {
    method: "remove_trust_rule",
    schema: RemoveRuleSchema,
    handler: (params?: Record<string, unknown>) => {
      const p = params as z.infer<typeof RemoveRuleSchema>;
      const success = removeRule(p.id);
      return { success };
    },
  },

  {
    method: "clear_trust_rules",
    handler: () => {
      clearRules();
      return { success: true };
    },
  },

  {
    method: "match_trust_rule",
    schema: MatchRuleSchema,
    handler: (params?: Record<string, unknown>) => {
      const p = params as z.infer<typeof MatchRuleSchema>;

      if (p.commands && p.commands.length > 0) {
        const rule = findHighestPriorityRule(p.tool, p.commands, p.scope);
        return { rule: rule ?? null };
      }

      if (!p.pattern) {
        throw new Error('"pattern" or "commands" is required');
      }

      const rule = findMatchingRule(p.tool, p.pattern, p.scope);
      return { rule: rule ?? null };
    },
  },

  {
    method: "accept_starter_bundle",
    handler: () => {
      return acceptStarterBundle();
    },
  },
];
