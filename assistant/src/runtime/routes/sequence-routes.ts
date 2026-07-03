/**
 * Transport-agnostic routes for email sequence management.
 *
 * Handles listing, inspecting, pausing, resuming sequences,
 * cancelling enrollments, viewing stats, and managing guardrails.
 */

import { z } from "zod";

import { getDb } from "../../persistence/db-connection.js";
import {
  getGuardrailConfig,
  setGuardrailConfig,
} from "../../sequence/guardrails.js";
import {
  countActiveEnrollments,
  exitEnrollment,
  getSequence,
  listEnrollments,
  listSequences,
  updateSequence,
} from "../../sequence/store.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Schemas ─────────────────────────────────────────────────────────

const SequenceListParams = z
  .object({
    status: z.enum(["active", "paused", "archived"]).optional(),
  })
  .strict();

const SequenceIdParams = z
  .object({
    id: z.string().min(1),
  })
  .strict();

const CancelEnrollmentParams = z
  .object({
    enrollmentId: z.string().min(1),
  })
  .strict();

const GuardrailSetParams = z
  .object({
    key: z.string().min(1),
    value: z.string().min(1),
  })
  .strict();

// ── Handlers ────────────────────────────────────────────────────────

function handleSequenceList({ body = {} }: RouteHandlerArgs) {
  getDb();
  const { status } = SequenceListParams.parse(body);
  const filter = status ? { status } : undefined;
  const seqs = listSequences(filter);

  const sequences = seqs.map((seq) => ({
    ...seq,
    activeEnrollments: countActiveEnrollments(seq.id),
  }));

  return { ok: true, sequences };
}

function handleSequenceGet({ body = {} }: RouteHandlerArgs) {
  getDb();
  const { id } = SequenceIdParams.parse(body);
  const seq = getSequence(id);
  if (!seq) throw new NotFoundError(`Sequence not found: ${id}`);

  const enrollments = listEnrollments({ sequenceId: id });
  const statusCounts = enrollments.reduce(
    (acc, e) => {
      acc[e.status] = (acc[e.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return {
    ok: true,
    sequence: { ...seq, activeEnrollments: statusCounts["active"] ?? 0 },
    enrollments: { total: enrollments.length, byStatus: statusCounts },
  };
}

function handleSequencePause({ body = {} }: RouteHandlerArgs) {
  getDb();
  const { id } = SequenceIdParams.parse(body);
  const seq = getSequence(id);
  if (!seq) throw new NotFoundError(`Sequence not found: ${id}`);
  if (seq.status === "paused") {
    return { ok: true, message: "Sequence is already paused." };
  }
  updateSequence(id, { status: "paused" });
  return { ok: true, message: `Sequence "${seq.name}" paused.` };
}

function handleSequenceResume({ body = {} }: RouteHandlerArgs) {
  getDb();
  const { id } = SequenceIdParams.parse(body);
  const seq = getSequence(id);
  if (!seq) throw new NotFoundError(`Sequence not found: ${id}`);
  if (seq.status === "active") {
    return { ok: true, message: "Sequence is already active." };
  }
  updateSequence(id, { status: "active" });
  return { ok: true, message: `Sequence "${seq.name}" resumed.` };
}

function handleCancelEnrollment({ body = {} }: RouteHandlerArgs) {
  getDb();
  const { enrollmentId } = CancelEnrollmentParams.parse(body);
  exitEnrollment(enrollmentId, "cancelled");
  return { ok: true, message: `Enrollment ${enrollmentId} cancelled.` };
}

function handleSequenceStats() {
  getDb();
  const seqs = listSequences();
  const activeSeqs = seqs.filter((s) => s.status === "active").length;
  const allEnrollments = listEnrollments();
  const activeEnrollments = allEnrollments.filter(
    (e) => e.status === "active",
  ).length;

  return {
    ok: true,
    totalSequences: seqs.length,
    activeSequences: activeSeqs,
    totalEnrollments: allEnrollments.length,
    activeEnrollments,
  };
}

function handleGuardrailsShow() {
  const cfg = getGuardrailConfig();
  return { ok: true, config: cfg };
}

function handleGuardrailsSet({ body = {} }: RouteHandlerArgs) {
  const { key, value } = GuardrailSetParams.parse(body);
  const numVal = Number(value);
  const boolVal =
    value === "true" ? true : value === "false" ? false : undefined;

  const patch: Partial<ReturnType<typeof getGuardrailConfig>> = {};
  switch (key) {
    case "dailySendCap":
    case "daily_send_cap":
      if (!Number.isFinite(numVal))
        throw new BadRequestError(`Invalid numeric value for ${key}: ${value}`);
      patch.dailySendCap = numVal;
      break;
    case "perSequenceHourlyRate":
    case "hourly_rate":
      if (!Number.isFinite(numVal))
        throw new BadRequestError(`Invalid numeric value for ${key}: ${value}`);
      patch.perSequenceHourlyRate = numVal;
      break;
    case "minimumStepDelaySec":
    case "min_delay":
      if (!Number.isFinite(numVal))
        throw new BadRequestError(`Invalid numeric value for ${key}: ${value}`);
      patch.minimumStepDelaySec = numVal;
      break;
    case "maxActiveEnrollments":
    case "max_enrollments":
      if (!Number.isFinite(numVal))
        throw new BadRequestError(`Invalid numeric value for ${key}: ${value}`);
      patch.maxActiveEnrollments = numVal;
      break;
    case "duplicateEnrollmentCheck":
    case "duplicate_check":
      if (boolVal === undefined)
        throw new BadRequestError("Value must be true or false");
      patch.duplicateEnrollmentCheck = boolVal;
      break;
    case "cooldownPeriodMs":
      if (!Number.isFinite(numVal))
        throw new BadRequestError(`Invalid numeric value for ${key}: ${value}`);
      patch.cooldownPeriodMs = numVal;
      break;
    case "cooldown_days": {
      if (!Number.isFinite(numVal))
        throw new BadRequestError(`Invalid numeric value for ${key}: ${value}`);
      patch.cooldownPeriodMs = numVal * 24 * 60 * 60 * 1000;
      break;
    }
    default:
      throw new BadRequestError(`Unknown guardrail key: ${key}`);
  }

  const updated = setGuardrailConfig(patch);
  return { ok: true, message: `Updated ${key} = ${value}`, config: updated };
}

// ── Route definitions ───────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "sequence_list",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    endpoint: "sequences/list",
    handler: handleSequenceList,
    summary: "List sequences",
    description:
      "List all sequences, optionally filtered by status (active, paused, archived).",
    tags: ["sequences"],
    requestBody: SequenceListParams,
  },
  {
    operationId: "sequence_get",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    endpoint: "sequences/get",
    handler: handleSequenceGet,
    summary: "Get sequence details",
    description:
      "Get sequence details with enrollment stats, including step-by-step breakdown and enrollment status counts.",
    tags: ["sequences"],
    requestBody: SequenceIdParams,
  },
  {
    operationId: "sequence_pause",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    endpoint: "sequences/pause",
    handler: handleSequencePause,
    summary: "Pause a sequence",
    description:
      "Pause a sequence, halting all scheduled step deliveries. No-op if already paused.",
    tags: ["sequences"],
    requestBody: SequenceIdParams,
  },
  {
    operationId: "sequence_resume",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    endpoint: "sequences/resume",
    handler: handleSequenceResume,
    summary: "Resume a paused sequence",
    description:
      "Resume a paused sequence, re-enabling scheduled step deliveries. No-op if already active.",
    tags: ["sequences"],
    requestBody: SequenceIdParams,
  },
  {
    operationId: "sequence_cancel_enrollment",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    endpoint: "sequences/cancel-enrollment",
    handler: handleCancelEnrollment,
    summary: "Cancel a specific enrollment",
    description:
      "Cancel a specific enrollment, stopping all future step deliveries for that contact.",
    tags: ["sequences"],
    requestBody: CancelEnrollmentParams,
  },
  {
    operationId: "sequence_stats",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    endpoint: "sequences/stats",
    handler: handleSequenceStats,
    summary: "Overall sequence stats",
    description:
      "Returns aggregate statistics: total/active sequence counts and total/active enrollment counts.",
    tags: ["sequences"],
  },
  {
    operationId: "sequence_guardrails_show",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    endpoint: "sequences/guardrails",
    handler: handleGuardrailsShow,
    summary: "Show guardrail configuration",
    description:
      "Display the current guardrail configuration: daily send cap, hourly rate, step delay, max enrollments, duplicate check, and cooldown period.",
    tags: ["sequences"],
  },
  {
    operationId: "sequence_guardrails_set",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    endpoint: "sequences/guardrails",
    handler: handleGuardrailsSet,
    summary: "Update a guardrail setting",
    description:
      "Update a single guardrail setting by key. Valid keys: dailySendCap, perSequenceHourlyRate, minimumStepDelaySec, maxActiveEnrollments, duplicateEnrollmentCheck, cooldownPeriodMs, cooldown_days.",
    tags: ["sequences"],
    requestBody: GuardrailSetParams,
  },
];
