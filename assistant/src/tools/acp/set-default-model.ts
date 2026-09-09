import { z } from "zod";

import {
  formatResolveFailure,
  resolveAcpAgentId,
} from "../../acp/resolve-agent.js";
import { scrubNulledAcpModels } from "../../config/acp-model-write.js";
import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import { isPlainObject } from "../../util/object.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Model-input schema, `safeParse`d at the top of
 * {@link executeAcpSetDefaultModel}. `model` is nullable rather than
 * optional: `null` is the clear, so an omitted field is a caller mistake and
 * not a silent no-op.
 *
 * `agent` is trimmed and non-empty in the schema so an omitted agent (the
 * global default) stays distinguishable from a supplied blank one, which is
 * a caller mistake: trimming a blank to falsy in the body would silently
 * widen a request scoped to one agent into a write for every agent.
 */
export const acpSetDefaultModelInputSchema = z.looseObject({
  model: z.string().nullable(),
  agent: nullAsOmitted(z.string().trim().min(1)),
});

export async function executeAcpSetDefaultModel(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = acpSetDefaultModelInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("acp_set_default_model", parsedInput.error);
  }
  const model = parsedInput.data.model?.trim() ?? null;
  if (model === "") {
    return {
      content: 'Pass a model in "model", or null to clear the default.',
      isError: true,
    };
  }

  const requestedAgent = parsedInput.data.agent;
  let agent: { id: string; command: string } | undefined;
  if (requestedAgent !== undefined) {
    const resolved = resolveAcpAgentId(requestedAgent);
    if (!resolved.ok) {
      return {
        content: formatResolveFailure(requestedAgent, resolved),
        isError: true,
      };
    }
    agent = { id: resolved.id, command: resolved.command };
  }

  const raw = loadRawConfig();
  const changed = agent
    ? writeAgentModel(raw, agent, model)
    : writeDefaultModel(raw, model);
  if (changed) {
    scrubNulledAcpModels(raw);
    saveRawConfig(raw);
    invalidateConfigCache();
  }
  return { content: describeOutcome(agent?.id, model), isError: false };
}

/**
 * Sets or clears `acp.defaultModel`, reporting whether the raw config
 * changed. Clearing a key that is not there writes nothing, so an `acp`
 * block is never created just to hold nothing.
 */
function writeDefaultModel(
  raw: Record<string, unknown>,
  model: string | null,
): boolean {
  if (model !== null) {
    setNestedValue(raw, "acp.defaultModel", model);
    return true;
  }
  const acp = raw.acp;
  if (!isPlainObject(acp) || !("defaultModel" in acp)) {
    return false;
  }
  acp.defaultModel = null;
  return true;
}

/**
 * Sets or clears `acp.agents.<id>.model`.
 *
 * The agent id addresses the `agents` record as a literal key, never as a
 * segment of a dotted path: `AcpConfigSchema` keys agents by arbitrary
 * string, so an id carrying a dot ("team.agent") would otherwise be split
 * into nested objects, leaving the real entry untouched and persisting a
 * command-less one beside it.
 *
 * `AcpAgentConfigSchema` requires `command` and the bundled agents live in
 * code rather than in the file, so a new entry is seeded with the command the
 * resolver reports: a bare `{ model }` entry fails validation and takes the
 * whole `acp` section down with it on the next load.
 */
function writeAgentModel(
  raw: Record<string, unknown>,
  agent: { id: string; command: string },
  model: string | null,
): boolean {
  const agents = readAgentsRecord(raw);
  const existing = agents?.[agent.id];
  const entry = isPlainObject(existing) ? existing : undefined;

  if (model === null) {
    if (!entry || !("model" in entry)) {
      return false;
    }
    entry.model = null;
    return true;
  }

  const next = entry ?? {};
  if (typeof next.command !== "string") {
    next.command = agent.command;
  }
  next.model = model;
  if (agents) {
    agents[agent.id] = next;
  } else {
    setNestedValue(raw, "acp.agents", { [agent.id]: next });
  }
  return true;
}

function readAgentsRecord(
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const acp = raw.acp;
  if (!isPlainObject(acp)) {
    return undefined;
  }
  const agents = acp.agents;
  return isPlainObject(agents) ? agents : undefined;
}

/** States exactly what stands now, in the terms the user asked in. */
function describeOutcome(
  agentId: string | undefined,
  model: string | null,
): string {
  if (agentId === undefined) {
    return model === null
      ? "No default coding-agent model is set now, so new sessions use each agent's own default."
      : `The default coding-agent model is now "${model}". It applies to new sessions; a session already running keeps the model it started on.`;
  }
  return model === null
    ? `Agent "${agentId}" has no model of its own now, so new sessions fall back to the default coding-agent model, then to the agent's own default.`
    : `Agent "${agentId}" now starts new sessions on "${model}". A session already running keeps the model it started on.`;
}
