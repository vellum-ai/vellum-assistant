/**
 * Trust rule CRUD endpoints for the gateway.
 *
 * All endpoints require "edge" auth. The assistant daemon will call these
 * endpoints instead of reading trust.json directly once the migration is
 * complete (PR 14-16 in the docker-volume-security plan).
 */

import { getLogger } from "../../logger.js";
import {
  addRule,
  updateRule,
  removeRule,
  clearRules,
  getAllRules,
  findMatchingRule,
  findHighestPriorityRule,
  acceptStarterBundle,
  type TrustDecision,
} from "../../trust-store.js";

const log = getLogger("trust-rules");

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidDecision(value: unknown): value is TrustDecision {
  return value === "allow" || value === "deny" || value === "ask";
}

// ---------------------------------------------------------------------------
// GET /v1/trust-rules — list all rules
// ---------------------------------------------------------------------------

export function createTrustRulesListHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      const rules = getAllRules();
      return Response.json({ rules });
    } catch (err) {
      log.error({ err }, "Failed to list trust rules");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /v1/trust-rules — add rule
// ---------------------------------------------------------------------------

export function createTrustRulesAddHandler() {
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

    const { tool, pattern, scope, decision, priority, allowHighRisk, executionTarget } =
      body as Record<string, unknown>;

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
    if (typeof scope !== "string" || !scope) {
      return Response.json(
        { error: '"scope" must be a non-empty string' },
        { status: 400 },
      );
    }
    if (decision !== undefined && !isValidDecision(decision)) {
      return Response.json(
        { error: '"decision" must be one of: allow, deny, ask' },
        { status: 400 },
      );
    }
    if (priority !== undefined && (typeof priority !== "number" || !Number.isFinite(priority))) {
      return Response.json(
        { error: '"priority" must be a finite number' },
        { status: 400 },
      );
    }
    if (allowHighRisk !== undefined && typeof allowHighRisk !== "boolean") {
      return Response.json(
        { error: '"allowHighRisk" must be a boolean' },
        { status: 400 },
      );
    }
    if (executionTarget !== undefined && typeof executionTarget !== "string") {
      return Response.json(
        { error: '"executionTarget" must be a string' },
        { status: 400 },
      );
    }

    try {
      const rule = addRule(
        tool,
        pattern,
        scope,
        (decision as TrustDecision) ?? "allow",
        (priority as number) ?? 100,
        {
          allowHighRisk: allowHighRisk as boolean | undefined,
          executionTarget: executionTarget as string | undefined,
        },
      );
      return Response.json({ rule }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      log.error({ err }, "Failed to add trust rule");
      return Response.json({ error: message }, { status: 400 });
    }
  };
}

// ---------------------------------------------------------------------------
// PATCH /v1/trust-rules/:id — update rule
// ---------------------------------------------------------------------------

export function createTrustRulesUpdateHandler() {
  return async (req: Request, ruleId: string): Promise<Response> => {
    if (!ruleId) {
      return Response.json(
        { error: "Rule ID is required" },
        { status: 400 },
      );
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

    const { tool, pattern, scope, decision, priority } =
      body as Record<string, unknown>;

    if (tool !== undefined && (typeof tool !== "string" || !tool)) {
      return Response.json(
        { error: '"tool" must be a non-empty string' },
        { status: 400 },
      );
    }
    if (pattern !== undefined && (typeof pattern !== "string" || !pattern)) {
      return Response.json(
        { error: '"pattern" must be a non-empty string' },
        { status: 400 },
      );
    }
    if (scope !== undefined && (typeof scope !== "string" || !scope)) {
      return Response.json(
        { error: '"scope" must be a non-empty string' },
        { status: 400 },
      );
    }
    if (decision !== undefined && !isValidDecision(decision)) {
      return Response.json(
        { error: '"decision" must be one of: allow, deny, ask' },
        { status: 400 },
      );
    }
    if (priority !== undefined && (typeof priority !== "number" || !Number.isFinite(priority))) {
      return Response.json(
        { error: '"priority" must be a finite number' },
        { status: 400 },
      );
    }

    try {
      const rule = updateRule(ruleId, {
        tool: tool as string | undefined,
        pattern: pattern as string | undefined,
        scope: scope as string | undefined,
        decision: decision as TrustDecision | undefined,
        priority: priority as number | undefined,
      });
      return Response.json({ rule });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      if (message.includes("not found")) {
        return Response.json({ error: message }, { status: 404 });
      }
      log.error({ err }, "Failed to update trust rule");
      return Response.json({ error: message }, { status: 400 });
    }
  };
}

// ---------------------------------------------------------------------------
// DELETE /v1/trust-rules/:id — remove rule
// ---------------------------------------------------------------------------

export function createTrustRulesDeleteHandler() {
  return async (_req: Request, ruleId: string): Promise<Response> => {
    if (!ruleId) {
      return Response.json(
        { error: "Rule ID is required" },
        { status: 400 },
      );
    }

    try {
      const removed = removeRule(ruleId);
      if (!removed) {
        return Response.json(
          { error: `Trust rule not found: ${ruleId}` },
          { status: 404 },
        );
      }
      return Response.json({ success: true });
    } catch (err) {
      log.error({ err }, "Failed to remove trust rule");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /v1/trust-rules/clear — clear all user rules
// ---------------------------------------------------------------------------

export function createTrustRulesClearHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      clearRules();
      return Response.json({ success: true });
    } catch (err) {
      log.error({ err }, "Failed to clear trust rules");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// GET /v1/trust-rules/match — query matching rule
// ---------------------------------------------------------------------------

export function createTrustRulesMatchHandler() {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const tool = url.searchParams.get("tool");
    const pattern = url.searchParams.get("pattern");
    const scope = url.searchParams.get("scope");
    const commandsParam = url.searchParams.get("commands");

    if (!tool) {
      return Response.json(
        { error: '"tool" query parameter is required' },
        { status: 400 },
      );
    }
    if (!scope) {
      return Response.json(
        { error: '"scope" query parameter is required' },
        { status: 400 },
      );
    }

    try {
      // Support two modes:
      // 1. Single pattern match: ?tool=X&pattern=Y&scope=Z
      // 2. Multi-command highest priority: ?tool=X&commands=Y,Z&scope=S
      if (commandsParam) {
        const commands = commandsParam.split(",").filter(Boolean);
        if (commands.length === 0) {
          return Response.json(
            { error: '"commands" must contain at least one command' },
            { status: 400 },
          );
        }
        const rule = findHighestPriorityRule(tool, commands, scope);
        return Response.json({ rule: rule ?? null });
      }

      if (!pattern) {
        return Response.json(
          { error: '"pattern" or "commands" query parameter is required' },
          { status: 400 },
        );
      }

      const rule = findMatchingRule(tool, pattern, scope);
      return Response.json({ rule: rule ?? null });
    } catch (err) {
      log.error({ err }, "Failed to find matching trust rule");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /v1/trust-rules/starter-bundle — accept starter bundle
// ---------------------------------------------------------------------------

export function createTrustRulesStarterBundleHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      const result = acceptStarterBundle();
      return Response.json(result);
    } catch (err) {
      log.error({ err }, "Failed to accept starter bundle");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
