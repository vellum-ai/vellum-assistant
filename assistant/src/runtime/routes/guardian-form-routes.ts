/**
 * The form-agnostic half of the guardian-form IPC surface.
 *
 * A form's own route carries its schema and its wire events; these two are the
 * same for every form, so a new one gets them without adding routes of its own:
 *
 *   - `guardian_form_claim`   the writer takes the form before writing
 *   - `resolve_guardian_form` the writer reports back, unblocking the command
 *
 * The contact forms predate these and keep their own `contact_prompt_claim` /
 * `resolve_contact_prompt` names, because the gateway that calls them ships
 * separately from the daemon and an older one still uses the old names. New
 * forms should use these.
 */

import { z } from "zod";

import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  claimGuardianForm,
  type GuardianFormResult,
  resolveGuardianForm,
} from "../guardian-form-registry.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const RequestIdParams = z.object({
  requestId: z.string().describe("The pending form's id."),
});

/**
 * Hand a writer's report to the call parked on the form.
 *
 * Everything but `requestId` and `error` is passed through untouched, so a
 * form's result is whatever its writer chose to send. An `error` is what makes
 * it a failure; there is no other flag.
 */
export function resolveFormFromCallback({ body = {} }: RouteHandlerArgs): {
  resolved: boolean;
} {
  const {
    requestId,
    error,
    ...rest
  }: { requestId: string; error?: string } & Record<string, unknown> =
    body as never;

  const result: GuardianFormResult = error
    ? { ok: false, error }
    : { ok: true, ...rest };
  return resolveGuardianForm(requestId, result);
}

export function claimForm({ body = {} }: RouteHandlerArgs): {
  claimed: boolean;
  reason?: "already_claimed" | "unknown";
  settleMs?: number;
} {
  const { requestId } = RequestIdParams.parse(body);
  return claimGuardianForm(requestId);
}

const CLAIM_RESPONSE = z.object({
  claimed: z.boolean(),
  reason: z.enum(["already_claimed", "unknown"]).optional(),
  settleMs: z
    .number()
    .optional()
    .describe(
      "How long a granted claim has to report its write back before the waiting call gives up.",
    ),
});

export const GUARDIAN_FORM_ROUTES: RouteDefinition[] = [
  {
    operationId: "guardian_form_claim",
    endpoint: "guardian_form_claim",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: claimForm,
    summary: "Claim a pending guardian form for one submission",
    description:
      "Marks a pending form as answered so a second client submitting the same form writes nothing. Returns claimed=false with reason 'already_claimed' when somebody got there first, or 'unknown' when no such form is pending. A granted claim carries the window its write has to report back in.",
    tags: ["guardian-forms"],
    requestBody: RequestIdParams,
    responseBody: CLAIM_RESPONSE,
  },
  {
    operationId: "resolve_guardian_form",
    endpoint: "resolve_guardian_form",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: resolveFormFromCallback,
    summary: "Report a guardian form's outcome back to the waiting command",
    description:
      "Called by the writer once it has committed (or failed). Fields other than requestId and error are passed through to the parked caller untouched; an error makes the outcome a failure.",
    tags: ["guardian-forms"],
    requestBody: RequestIdParams.catchall(z.unknown()),
    responseBody: z.object({ resolved: z.boolean() }),
  },
];
