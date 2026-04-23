/**
 * Trust rule v3 CRUD endpoints for the gateway.
 *
 * All mutation endpoints are gated behind the `permission-controls-v3`
 * feature flag. Read endpoints (list) are always available so the UI
 * can display rules regardless of the flag state.
 *
 * Mutations invalidate the in-memory risk rule cache so subsequent
 * classifications reflect the change immediately.
 */

import { TrustRuleV3Store } from "../../db/trust-rule-v3-store.js";
import { invalidateTrustRuleV3Cache } from "../../risk/trust-rule-v3-cache.js";
import { getMergedFeatureFlags } from "../../ipc/feature-flag-handlers.js";
import { DEFAULT_COMMAND_REGISTRY } from "../../risk/command-registry.js";
import { getLogger } from "../../logger.js";

const log = getLogger("trust-rules-v3");

const VALID_RISK_VALUES = new Set(["low", "medium", "high"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check the `permission-controls-v3` feature flag.
 * Returns a 403 Response if the flag is disabled, or null if enabled.
 */
function requireV3Flag(): Response | null {
  if (!getMergedFeatureFlags()["permission-controls-v3"]) {
    return Response.json({ error: "Feature not enabled" }, { status: 403 });
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /v1/trust-rules-v3 — list rules
// ---------------------------------------------------------------------------

export function createTrustRuleV3sListHandler() {
  const store = new TrustRuleV3Store();

  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      const origin = url.searchParams.get("origin") ?? undefined;
      const tool = url.searchParams.get("tool") ?? undefined;
      const includeDeleted = url.searchParams.get("include_deleted") === "true";

      const rules = store.list({ origin, tool, includeDeleted });
      return Response.json({ rules });
    } catch (err) {
      log.error({ err }, "Failed to list v3 trust rules");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /v1/trust-rules-v3 — create rule
// ---------------------------------------------------------------------------

export function createTrustRuleV3sCreateHandler() {
  const store = new TrustRuleV3Store();

  return async (req: Request): Promise<Response> => {
    const flagResponse = requireV3Flag();
    if (flagResponse) return flagResponse;

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
      invalidateTrustRuleV3Cache();
      return Response.json({ rule }, { status: 201 });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      log.error({ err }, "Failed to create v3 trust rule");
      return Response.json({ error: message }, { status: 400 });
    }
  };
}

// ---------------------------------------------------------------------------
// PATCH /v1/trust-rules-v3/:id — update rule
// ---------------------------------------------------------------------------

export function createTrustRuleV3sUpdateHandler() {
  const store = new TrustRuleV3Store();

  return async (req: Request, ruleId: string): Promise<Response> => {
    const flagResponse = requireV3Flag();
    if (flagResponse) return flagResponse;

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
      invalidateTrustRuleV3Cache();
      return Response.json({ rule });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      if (message.includes("not found")) {
        return Response.json({ error: message }, { status: 404 });
      }
      log.error({ err }, "Failed to update v3 trust rule");
      return Response.json({ error: message }, { status: 400 });
    }
  };
}

// ---------------------------------------------------------------------------
// DELETE /v1/trust-rules-v3/:id — delete rule
// ---------------------------------------------------------------------------

export function createTrustRuleV3sDeleteHandler() {
  const store = new TrustRuleV3Store();

  return async (_req: Request, ruleId: string): Promise<Response> => {
    const flagResponse = requireV3Flag();
    if (flagResponse) return flagResponse;

    if (!ruleId) {
      return Response.json({ error: "Rule ID is required" }, { status: 400 });
    }

    try {
      store.remove(ruleId);
      invalidateTrustRuleV3Cache();
      return Response.json({ success: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      if (message.includes("not found")) {
        return Response.json({ error: message }, { status: 404 });
      }
      log.error({ err }, "Failed to delete v3 trust rule");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /v1/trust-rules-v3/:id/reset — reset default rule
// ---------------------------------------------------------------------------

/**
 * Look up the original base risk for a default rule by parsing its pattern
 * against the DEFAULT_COMMAND_REGISTRY.
 *
 * For simple commands (e.g. "ls"), looks up `registry.ls.baseRisk`.
 * For subcommands (e.g. "git push"), looks up `registry.git.subcommands.push.baseRisk`.
 */
function lookupOriginalRisk(pattern: string): string | null {
  const parts = pattern.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const command = parts[0];
  const spec = (DEFAULT_COMMAND_REGISTRY as Record<string, unknown>)[command];
  if (!spec || typeof spec !== "object") return null;

  const typed = spec as {
    baseRisk: string;
    subcommands?: Record<
      string,
      { baseRisk: string; subcommands?: Record<string, { baseRisk: string }> }
    >;
  };

  // Walk subcommand chain
  if (parts.length > 1 && typed.subcommands) {
    let current: {
      baseRisk: string;
      subcommands?: Record<
        string,
        { baseRisk: string; subcommands?: Record<string, { baseRisk: string }> }
      >;
    } = typed;
    for (let i = 1; i < parts.length; i++) {
      const sub = current.subcommands?.[parts[i]];
      if (!sub) break;
      current = sub as typeof current;
    }
    return current.baseRisk;
  }

  return typed.baseRisk;
}

export function createTrustRuleV3sResetHandler() {
  const store = new TrustRuleV3Store();

  return async (_req: Request, ruleId: string): Promise<Response> => {
    const flagResponse = requireV3Flag();
    if (flagResponse) return flagResponse;

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

    // Determine original risk from the command registry
    const originalRisk = lookupOriginalRisk(existing.pattern);
    if (!originalRisk) {
      return Response.json(
        {
          error: `Cannot determine original risk for pattern: ${existing.pattern}`,
        },
        { status: 400 },
      );
    }

    try {
      const rule = store.reset(ruleId, originalRisk);
      invalidateTrustRuleV3Cache();
      return Response.json({ rule });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      if (message.includes("not found")) {
        return Response.json({ error: message }, { status: 404 });
      }
      log.error({ err }, "Failed to reset v3 trust rule");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
