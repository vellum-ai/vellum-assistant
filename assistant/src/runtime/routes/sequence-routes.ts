/**
 * Route handlers for sequence management.
 *
 * All routes are served by both the HTTP server and the IPC server via
 * the shared ROUTES array.
 */

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
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Handlers (transport-agnostic)
// ---------------------------------------------------------------------------

function handleSequenceList(args: RouteHandlerArgs) {
  const status = args.queryParams?.status;
  const seqs = listSequences(
    status
      ? { status: status as "active" | "paused" | "archived" }
      : undefined,
  );
  const sequences = seqs.map((seq) => ({
    ...seq,
    activeEnrollments: countActiveEnrollments(seq.id),
  }));
  return { sequences };
}

function handleSequenceGet(args: RouteHandlerArgs) {
  const id = args.queryParams?.id;
  if (!id) throw new BadRequestError("id is required");

  const sequence = getSequence(id);
  if (!sequence) throw new NotFoundError(`Sequence not found: ${id}`);

  const enrollments = listEnrollments({ sequenceId: id });
  const activeEnrollments = countActiveEnrollments(id);
  return { sequence, enrollments, activeEnrollments };
}

function handleSequencePause(args: RouteHandlerArgs) {
  const id = (args.body as any)?.id as string | undefined;
  if (!id) throw new BadRequestError("id is required");

  const sequence = updateSequence(id, { status: "paused" });
  if (!sequence) throw new NotFoundError(`Sequence not found: ${id}`);
  return { sequence };
}

function handleSequenceResume(args: RouteHandlerArgs) {
  const id = (args.body as any)?.id as string | undefined;
  if (!id) throw new BadRequestError("id is required");

  const sequence = updateSequence(id, { status: "active" });
  if (!sequence) throw new NotFoundError(`Sequence not found: ${id}`);
  return { sequence };
}

function handleSequenceEnrollmentCancel(args: RouteHandlerArgs) {
  const enrollmentId = (args.body as any)?.enrollmentId as string | undefined;
  if (!enrollmentId) throw new BadRequestError("enrollmentId is required");

  exitEnrollment(enrollmentId, "cancelled");
  return { ok: true };
}

function handleSequenceStats(_args: RouteHandlerArgs) {
  const seqs = listSequences();
  const sequences = seqs.map((seq) => ({
    id: seq.id,
    name: seq.name,
    status: seq.status,
    stepCount: seq.steps.length,
    activeEnrollments: countActiveEnrollments(seq.id),
  }));
  return { sequences };
}

function handleSequenceGuardrailsGet(_args: RouteHandlerArgs) {
  return getGuardrailConfig();
}

const GUARDRAIL_NUMERIC_KEYS = [
  "dailySendCap",
  "perSequenceHourlyRate",
  "minimumStepDelaySec",
  "maxActiveEnrollments",
  "cooldownPeriodMs",
] as const;

const VALID_GUARDRAIL_KEYS = [
  ...GUARDRAIL_NUMERIC_KEYS,
  "duplicateEnrollmentCheck",
] as const;

type GuardrailKey = (typeof VALID_GUARDRAIL_KEYS)[number];

function handleSequenceGuardrailsSet(args: RouteHandlerArgs) {
  const key = (args.body as any)?.key as string | undefined;
  const value = (args.body as any)?.value as string | undefined;

  if (!key) throw new BadRequestError("key is required");
  if (value === undefined) throw new BadRequestError("value is required");

  if (!VALID_GUARDRAIL_KEYS.includes(key as GuardrailKey)) {
    throw new BadRequestError(
      `Invalid guardrail key: ${key}. Valid keys: ${VALID_GUARDRAIL_KEYS.join(", ")}`,
    );
  }

  let parsed: number | boolean;
  if (key === "duplicateEnrollmentCheck") {
    parsed = value === "true";
  } else {
    parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new BadRequestError(
        `Invalid numeric value for ${key}: ${value}`,
      );
    }
  }

  return setGuardrailConfig({ [key]: parsed });
}

// ---------------------------------------------------------------------------
// Shared route definitions (HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "sequence_list",
    endpoint: "sequence/list",
    method: "GET",
    handler: handleSequenceList,
  },
  {
    operationId: "sequence_get",
    endpoint: "sequence/get",
    method: "GET",
    handler: handleSequenceGet,
  },
  {
    operationId: "sequence_pause",
    endpoint: "sequence/pause",
    method: "POST",
    handler: handleSequencePause,
  },
  {
    operationId: "sequence_resume",
    endpoint: "sequence/resume",
    method: "POST",
    handler: handleSequenceResume,
  },
  {
    operationId: "sequence_enrollment_cancel",
    endpoint: "sequence/enrollment/cancel",
    method: "POST",
    handler: handleSequenceEnrollmentCancel,
  },
  {
    operationId: "sequence_stats",
    endpoint: "sequence/stats",
    method: "GET",
    handler: handleSequenceStats,
  },
  {
    operationId: "sequence_guardrails_get",
    endpoint: "sequence/guardrails",
    method: "GET",
    handler: handleSequenceGuardrailsGet,
  },
  {
    operationId: "sequence_guardrails_set",
    endpoint: "sequence/guardrails/set",
    method: "POST",
    handler: handleSequenceGuardrailsSet,
  },
];
