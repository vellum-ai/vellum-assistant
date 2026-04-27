/**
 * Trust rule v3 CRUD endpoints for the gateway.
 *
 * Mutations invalidate the in-memory risk rule cache so subsequent
 * classifications reflect the change immediately.
 */

import { z } from "zod";
import {
  TrustRuleStore,
  VALID_RISK_VALUES,
} from "../../db/trust-rule-store.js";
import { invalidateTrustRuleCache } from "../../risk/trust-rule-cache.js";
import { DEFAULT_COMMAND_REGISTRY } from "../../risk/command-registry/index.js";
import { getLogger } from "../../logger.js";
import { ipcSuggestTrustRule } from "../../ipc/assistant-client.js";
import { getGatewayDb } from "../../db/connection.js";
import { autoApproveThresholds } from "../../db/schema.js";
import { eq } from "drizzle-orm";

const log = getLogger("trust-rules");

// ---------------------------------------------------------------------------
// Zod schema for POST /v1/trust-rules/suggest request body
// ---------------------------------------------------------------------------

const SuggestRequestSchema = z.object({
  tool: z.string().min(1),
  command: z.string().min(1),
  riskAssessment: z.object({
    risk: z.string(),
    reasoning: z.string(),
    reasonDescription: z.string(),
  }),
  scopeOptions: z.array(
    z.object({
      pattern: z.string(),
      label: z.string(),
    }),
  ),
  directoryScopeOptions: z
    .array(
      z.object({
        scope: z.string(),
        label: z.string(),
      }),
    )
    .optional(),
  intent: z.enum(["auto_approve", "escalate"]),
});

/**
 * Read the interactive auto-approve threshold from the DB.
 * Falls back to "low" if the DB is unavailable or the row is missing.
 */
function readInteractiveThreshold(): string {
  try {
    const db = getGatewayDb();
    const row = db
      .select()
      .from(autoApproveThresholds)
      .where(eq(autoApproveThresholds.id, 1))
      .get();
    return row?.interactive ?? "medium";
  } catch {
    return "low";
  }
}

// ---------------------------------------------------------------------------
// POST /v1/trust-rules/suggest — LLM-generated trust rule suggestion
// ---------------------------------------------------------------------------

export function createTrustRulesSuggestHandler() {
  return async (req: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    const parsed = SuggestRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid request body", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const currentThreshold = readInteractiveThreshold();

    try {
      const suggestion = await ipcSuggestTrustRule({
        ...parsed.data,
        currentThreshold,
      });
      return Response.json({ suggestion });
    } catch (err) {
      log.error({ err }, "Trust rule suggestion failed");
      const message =
        err instanceof Error ? err.message : "Suggestion generation failed";
      return Response.json({ error: message }, { status: 503 });
    }
  };
}

// ---------------------------------------------------------------------------
// GET /v1/trust-rules — list rules
// ---------------------------------------------------------------------------

export function createTrustRulesListHandler() {
  const store = new TrustRuleStore();

  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      const origin = url.searchParams.get("origin") ?? undefined;
      const tool = url.searchParams.get("tool") ?? undefined;
      const includeDeleted = url.searchParams.get("include_deleted") === "true";

      // When no origin filter is specified, default to user-relevant rules
      // only (user_defined + user-modified defaults). This excludes unmodified
      // defaults and soft-deleted rules from the default listing.
      const userRelevantOnly = origin === undefined;

      const rules = store.list({
        origin,
        tool,
        includeDeleted,
        userRelevantOnly,
      });
      return Response.json({ rules });
    } catch (err) {
      log.error({ err }, "Failed to list trust rules");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /v1/trust-rules — create rule
// ---------------------------------------------------------------------------

export function createTrustRulesCreateHandler() {
  const store = new TrustRuleStore();

  return async (req: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const { tool, pattern, risk, description } = body as Record<
      string,
      unknown
    >;

    if (typeof tool !== "string" || !tool) {
      return Response.json(
        { error: '"tool" must be a non-empty string' },
        { status: 400 },
      );
    }
    if (typeof pattern !== "string" || !pattern) {
      return Response.json(
        { error: '"pattern" must be a non-empty string' },
        { status: 400 },
      );
    }
    if (typeof risk !== "string" || !VALID_RISK_VALUES.has(risk)) {
      return Response.json(
        { error: '"risk" must be one of: low, medium, high' },
        { status: 400 },
      );
    }
    if (typeof description !== "string" || !description) {
      return Response.json(
        { error: '"description" must be a non-empty string' },
        { status: 400 },
      );
    }

    try {
      const rule = store.create({ tool, pattern, risk, description });
      invalidateTrustRuleCache();
      return Response.json({ rule }, { status: 201 });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      log.error({ err }, "Failed to create trust rule");
      return Response.json({ error: message }, { status: 400 });
    }
  };
}

// ---------------------------------------------------------------------------
// PATCH /v1/trust-rules/:id — update rule
// ---------------------------------------------------------------------------

export function createTrustRulesUpdateHandler() {
  const store = new TrustRuleStore();

  return async (req: Request, ruleId: string): Promise<Response> => {
    if (!ruleId) {
      return Response.json({ error: "Rule ID is required" }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const { risk, description } = body as Record<string, unknown>;

    if (
      risk !== undefined &&
      (typeof risk !== "string" || !VALID_RISK_VALUES.has(risk))
    ) {
      return Response.json(
        { error: '"risk" must be one of: low, medium, high' },
        { status: 400 },
      );
    }

    if (description !== undefined && typeof description !== "string") {
      return Response.json(
        { error: '"description" must be a string' },
        { status: 400 },
      );
    }

    try {
      const rule = store.update(ruleId, {
        risk: risk as string | undefined,
        description: description as string | undefined,
      });
      invalidateTrustRuleCache();
      return Response.json({ rule });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      if (message.includes("not found")) {
        return Response.json({ error: message }, { status: 404 });
      }
      log.error({ err }, "Failed to update trust rule");
      return Response.json({ error: message }, { status: 400 });
    }
  };
}

// ---------------------------------------------------------------------------
// DELETE /v1/trust-rules/:id — delete rule
// ---------------------------------------------------------------------------

export function createTrustRulesDeleteHandler() {
  const store = new TrustRuleStore();

  return async (_req: Request, ruleId: string): Promise<Response> => {
    if (!ruleId) {
      return Response.json({ error: "Rule ID is required" }, { status: 400 });
    }

    try {
      store.remove(ruleId);
      invalidateTrustRuleCache();
      return Response.json({ success: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      if (message.includes("not found")) {
        return Response.json({ error: message }, { status: 404 });
      }
      log.error({ err }, "Failed to delete trust rule");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /v1/trust-rules/:id/reset — reset default rule
// ---------------------------------------------------------------------------

/**
 * Look up the original base risk and description for a default rule by parsing
 * its pattern against the DEFAULT_COMMAND_REGISTRY.
 *
 * For simple commands (e.g. "ls"), looks up `registry.ls.baseRisk`.
 * For subcommands (e.g. "git push"), looks up `registry.git.subcommands.push.baseRisk`.
 */
function lookupOriginalDefaults(
  pattern: string,
): { risk: string; description: string } | null {
  const parts = pattern.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const command = parts[0];
  const spec = (DEFAULT_COMMAND_REGISTRY as Record<string, unknown>)[command];
  if (!spec || typeof spec !== "object") return null;

  const typed = spec as {
    baseRisk: string;
    reason?: string;
    subcommands?: Record<
      string,
      {
        baseRisk: string;
        reason?: string;
        subcommands?: Record<string, { baseRisk: string; reason?: string }>;
      }
    >;
  };

  // Walk subcommand chain
  let resolved: { baseRisk: string; reason?: string } = typed;
  if (parts.length > 1 && typed.subcommands) {
    let current: typeof typed = typed;
    for (let i = 1; i < parts.length; i++) {
      const sub = current.subcommands?.[parts[i]];
      if (!sub) break;
      current = sub as typeof current;
    }
    resolved = current;
  }

  const description = resolved.reason
    ? `${pattern} \u2014 ${resolved.reason}`
    : `${pattern} (default)`;

  return { risk: resolved.baseRisk, description };
}

export function createTrustRulesResetHandler() {
  const store = new TrustRuleStore();

  return async (_req: Request, ruleId: string): Promise<Response> => {
    if (!ruleId) {
      return Response.json({ error: "Rule ID is required" }, { status: 400 });
    }

    // Look up the rule first to validate origin
    const existing = store.getById(ruleId);
    if (!existing) {
      return Response.json(
        { error: `Trust rule not found: ${ruleId}` },
        { status: 404 },
      );
    }

    if (existing.origin !== "default") {
      return Response.json(
        { error: "Can only reset default rules" },
        { status: 400 },
      );
    }

    // Determine original risk and description from the command registry
    const originalDefaults = lookupOriginalDefaults(existing.pattern);
    if (!originalDefaults) {
      return Response.json(
        {
          error: `Cannot determine original values for pattern: ${existing.pattern}`,
        },
        { status: 400 },
      );
    }

    try {
      const rule = store.reset(
        ruleId,
        originalDefaults.risk,
        originalDefaults.description,
      );
      invalidateTrustRuleCache();
      return Response.json({ rule });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      if (message.includes("not found")) {
        return Response.json({ error: message }, { status: 404 });
      }
      log.error({ err }, "Failed to reset trust rule");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
