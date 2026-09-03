/**
 * IPC routes for the contact forms the guardian fills in their app.
 *
 * Two commands park on the guardian-form rail:
 *   - `contacts/prompt` collects a channel address and binds a channel.
 *   - `contacts/record-prompt` confirms a contact record write the assistant
 *     proposed (create, update, delete, merge). No address is bound.
 *
 * Flow, identical for both:
 *   1. CLI calls the IPC route with what the assistant proposes.
 *   2. The route parks the call in the guardian-form registry, which broadcasts
 *      a `contact_request` / `contact_record_request` to connected clients.
 *   3. Client shows the form. The guardian edits and submits, or dismisses.
 *   4. Client POSTs to the gateway (`/v1/contacts/prompt/submit` or
 *      `/v1/contacts/record/submit`).
 *   5. Gateway performs the write (gateway owns all contact writes), attesting
 *      the channel when the guardian left the verify box checked.
 *   6. Gateway calls daemon IPC `resolve_contact_prompt`.
 *   7. The registry resolves the parked promise and the CLI call returns.
 *
 * The daemon only broadcasts and waits. It never writes contacts. That is what
 * makes these commands guardian-gated: with no human at a form, nothing is
 * written, and the call times out.
 *
 * The lifecycle itself lives in `runtime/guardian-form-registry.ts` and is
 * shared by every guardian form. What is here is the contact-shaped half: the
 * schemas, the two wire events, and the result the CLI gets back.
 */

import { z } from "zod";

import { GUARDIAN_FORM_MAX_TIMEOUT_MS } from "../../util/guardian-form-timeouts.js";
import { broadcastMessage } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  getGuardianFormMeta,
  type GuardianFormClosedReason,
  hasUnclaimedGuardianForm,
  openGuardianForm,
} from "../guardian-form-registry.js";
import { claimForm, resolveFormFromCallback } from "./guardian-form-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

/**
 * Form kinds on the guardian-form rail that carry a contact card.
 *
 * The gateway names the same kind when it claims, so these two strings are a
 * cross-package contract. `contact-form-kinds.test.ts` on each side pins the
 * literals, since a rename on one side alone would only surface as claims
 * rejected at runtime.
 */
export const CONTACT_ADDRESS_FORM_KIND = "contacts.address";
export const CONTACT_RECORD_FORM_KIND = "contacts.record";
const ADDRESS_FORM = CONTACT_ADDRESS_FORM_KIND;
const RECORD_FORM = CONTACT_RECORD_FORM_KIND;

const TimeoutMsParam = z
  .number()
  .int()
  .positive()
  .max(GUARDIAN_FORM_MAX_TIMEOUT_MS)
  .optional()
  .describe(
    "How long to hold the form open (ms). The caller waits slightly longer than this, so the form closing is what ends the wait. Defaults to 300000.",
  );

/** What the CLI gets back once the guardian has answered, or not. */
export interface ContactPromptResult {
  ok: boolean;
  error?: string;
  contactId?: string;
  channelId?: string;
  channelType?: string;
  address?: string;
  /** Whether the channel is attested, as the guardian's checkbox left it. */
  verified?: boolean;
  /**
   * Whether submitted notes reached storage. Absent when none were submitted.
   * False means the contact was written without them.
   */
  notesSaved?: boolean;
  /** Whether nothing the submission asked for landed. */
  nothingWritten?: boolean;
  /** Whether a merge committed. Absent on every other operation. */
  merged?: boolean;
  /**
   * Whether the survivor took the name the guardian submitted. False when the
   * merge committed but its rename could not land.
   */
  renamed?: boolean;
  /**
   * Whether a merge reached the assistant's copy of the contacts. False means
   * the merge committed, but the donor is still there with its notes on it
   * rather than combined onto the survivor.
   */
  mirrored?: boolean;
  /** The guardian dismissed the form. Nothing was written. */
  cancelled?: boolean;
}

/**
 * Tell every client a contact form is over.
 *
 * The form went to all of them, so one client answering leaves the others
 * holding a card that would now be refused. This is what takes those down.
 */
function announceContactFormClosed(
  requestId: string,
  reason: GuardianFormClosedReason,
): void {
  broadcastMessage({ type: "contact_form_closed", requestId, reason });
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ContactPromptParams = z.object({
  channel: z
    .string()
    .optional()
    .describe(
      "Suggested channel type hint (e.g. phone, email, telegram). Free text — not enforced.",
    ),
  placeholder: z
    .string()
    .optional()
    .describe("Placeholder text for the address input field."),
  defaultValue: z
    .string()
    .optional()
    .describe(
      "Suggested address to pre-fill the input with (e.g. a known email). The user can edit it before submitting.",
    ),
  label: z
    .string()
    .optional()
    .describe("Display label shown in the prompt UI."),
  description: z
    .string()
    .optional()
    .describe("Longer description for the prompt UI."),
  role: z
    .enum(["guardian", "trusted-contact", "unknown"])
    .default("unknown")
    .describe("Intended role of the contact being registered."),
  verify: z
    .boolean()
    .optional()
    .describe(
      "Pre-check the form's 'mark verified' box. The guardian's answer on submit decides the attest, so an unchecked box leaves the channel unverified.",
    ),
  contactId: z
    .string()
    .optional()
    .describe(
      "The contact this address binds to. Fixed by the command, not by the form.",
    ),
  contactDisplayName: z
    .string()
    .optional()
    .describe(
      "That contact's current name, so the form can say where the channel is going.",
    ),
  displayName: z
    .string()
    .optional()
    .describe(
      "Proposed name for a contact this form would create. Editable in the form.",
    ),
  notes: z
    .string()
    .optional()
    .describe("Proposed notes for a contact this form would create."),
  timeoutMs: TimeoutMsParam,
});

const ContactRecordPromptParams = z.object({
  operation: z
    .enum(["create", "update", "delete", "merge"])
    .describe("Which record write the guardian is being asked to confirm."),
  contactId: z
    .string()
    .optional()
    .describe(
      "Target contact. Required for update, delete and merge (the survivor).",
    ),
  currentDisplayName: z
    .string()
    .optional()
    .describe(
      "The target's current name, resolved by the caller, so the form can show what is changing. Gateway-owned facts are not read here.",
    ),
  currentNotes: z
    .string()
    .optional()
    .describe(
      "The target's current notes, resolved by the caller. The form submits a field only when it differs from what is stored.",
    ),
  channels: z
    .array(z.object({ type: z.string(), address: z.string() }))
    .optional()
    .describe(
      "The target's channels, resolved by the caller, so a delete confirmation can identify the contact and show what access is about to be lost.",
    ),

  donorContactId: z
    .string()
    .optional()
    .describe("The contact being merged away. Present only on a merge."),
  donorDisplayName: z
    .string()
    .optional()
    .describe(
      "That contact's name, so the confirmation can say who is being absorbed.",
    ),
  donorChannels: z
    .array(z.object({ type: z.string(), address: z.string() }))
    .optional()
    .describe("The channels moving to the survivor."),

  displayName: z
    .string()
    .optional()
    .describe(
      "Proposed name, prefilled into the form. The guardian can edit it.",
    ),
  notes: z
    .string()
    .optional()
    .describe(
      "Proposed notes, prefilled into the form. The guardian can edit them.",
    ),
  notesProposed: z
    .boolean()
    .optional()
    .describe(
      "Whether the caller asked for these notes explicitly, so the form submits them even when they match what is stored.",
    ),
  label: z.string().optional().describe("Display label shown in the form."),
  description: z
    .string()
    .optional()
    .describe("Longer description shown in the form."),
  timeoutMs: TimeoutMsParam,
});

const ContactPromptFlagsParams = z.object({
  requestId: z.string().describe("The pending contact_request id."),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Whether another contact form is already waiting on the guardian.
 *
 * Clients hold one contact card at a time, so a second broadcast replaces the
 * first and leaves its command waiting on a form nobody can answer. Refusing
 * fails the second command immediately instead, which is a caller that can
 * retry rather than one that hangs. Scoped to one kind: the two contact cards live in
 * separate client slots and render side by side, so only a second card of the
 * same kind replaces one.
 */
function contactFormAlreadyOpen(kind: string): ContactPromptResult | null {
  if (!hasUnclaimedGuardianForm([kind])) {
    return null;
  }
  return {
    ok: false,
    error:
      "Another contact form is already open. Wait for it to be answered, then try again.",
  };
}

async function handleContactPrompt({
  body = {},
}: RouteHandlerArgs): Promise<ContactPromptResult> {
  const {
    channel,
    placeholder,
    defaultValue,
    label,
    description,
    role,
    verify,
    contactId,
    contactDisplayName,
    displayName,
    notes,
    timeoutMs,
  } = ContactPromptParams.parse(body);

  if (contactId && (displayName !== undefined || notes !== undefined)) {
    return {
      ok: false,
      error:
        "Pass either contactId (bind to an existing contact) or displayName and notes (create a new one), not both. A contact that already exists is edited with 'assistant contacts update'.",
    };
  }

  const conflict = contactFormAlreadyOpen(ADDRESS_FORM);
  if (conflict) {
    return conflict;
  }

  return openGuardianForm<ContactPromptResult>({
    kind: ADDRESS_FORM,
    timeoutMs,
    // Read back by the gateway when a client too old for these fields submits
    // no answer of its own. Parking the target here rather than leaving it to
    // the client is what makes such a client still bind where the command said.
    meta: {
      verify: verify === true,
      ...(contactId ? { contactId } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(notes !== undefined ? { notes } : {}),
    },
    logContext: { channel, role, verify: verify === true, contactId },
    broadcast: {
      open: (requestId) =>
        broadcastMessage({
          type: "contact_request",
          requestId,
          channel,
          placeholder,
          defaultValue,
          label,
          description,
          role,
          // The checkbox's initial state. Carried in the broadcast so the form
          // can show what submitting will do; the client's answer is what the
          // gateway acts on.
          verify: verify === true,
          contactId,
          contactDisplayName,
          displayName,
          notes,
        }),
      closed: announceContactFormClosed,
    },
  });
}

/**
 * Park a proposed contact-record write until the guardian answers the form.
 *
 * The daemon writes nothing. It broadcasts the proposal and waits for the
 * gateway to report what the guardian actually submitted, which may differ
 * from what was proposed or may be a dismissal.
 */
async function handleContactRecordPrompt({
  body = {},
}: RouteHandlerArgs): Promise<ContactPromptResult> {
  const {
    operation,
    contactId,
    currentDisplayName,
    currentNotes,
    channels,
    donorContactId,
    donorDisplayName,
    donorChannels,
    displayName,
    notes,
    notesProposed,
    label,
    description,
    timeoutMs,
  } = ContactRecordPromptParams.parse(body);

  if (operation !== "create" && !contactId) {
    return { ok: false, error: `contactId is required to ${operation}` };
  }

  if (operation === "merge") {
    if (!donorContactId) {
      return { ok: false, error: "donorContactId is required to merge" };
    }
    if (donorContactId === contactId) {
      return { ok: false, error: "Cannot merge a contact with itself" };
    }
  }

  const conflict = contactFormAlreadyOpen(RECORD_FORM);
  if (conflict) {
    return conflict;
  }

  return openGuardianForm<ContactPromptResult>({
    kind: RECORD_FORM,
    timeoutMs,
    logContext: { operation, contactId, donorContactId },
    broadcast: {
      open: (requestId) =>
        broadcastMessage({
          type: "contact_record_request",
          requestId,
          operation,
          contactId,
          currentDisplayName,
          currentNotes,
          channels,
          donorContactId,
          donorDisplayName,
          donorChannels,
          displayName,
          notes,
          notesProposed,
          label,
          description,
        }),
      closed: announceContactFormClosed,
    },
  });
}

/** What a parked address form said its submission is for. */
interface ParkedPromptTarget {
  contactId?: string;
  displayName?: string;
  notes?: string;
}

const PARKED_TARGET_KEYS = ["contactId", "displayName", "notes"] as const;

/**
 * Read-only state for a pending prompt. The gateway asks this before it writes,
 * so the flag and the binding target come from the parked form rather than from
 * whatever the submitting client knew to echo.
 *
 * `known` says whether a form is still parked under the id. A restart between
 * the gateway's claim and this read leaves a form this process never saw, and
 * without the flag it answers exactly like one that parked no target, which
 * would leave the gateway resolving the address by itself.
 */
function readContactPromptFlags({
  body = {},
}: RouteHandlerArgs): ParkedPromptTarget & { verify: boolean; known: boolean } {
  const { requestId } = ContactPromptFlagsParams.parse(body);
  const meta = getGuardianFormMeta(requestId);
  const target: ParkedPromptTarget = {};
  for (const key of PARKED_TARGET_KEYS) {
    const value = meta?.[key];
    if (typeof value === "string") {
      target[key] = value;
    }
  }
  return {
    known: meta !== undefined,
    verify: meta?.verify === true,
    ...target,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const CONTACT_PROMPT_ROUTES: RouteDefinition[] = [
  {
    operationId: "contacts_prompt",
    endpoint: "contacts/prompt",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleContactPrompt,
    summary: "Prompt user to register a contact channel",
    description:
      "Broadcasts a contact_request to connected clients, waits for the user to submit an address via the gateway. The gateway owns the contact write and reports it back via resolve_contact_prompt.",
    tags: ["contacts"],
    requestBody: ContactPromptParams,
    responseBody: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      contactId: z.string().optional(),
      channelId: z.string().optional(),
      channelType: z.string().optional(),
      address: z.string().optional(),
      verified: z.boolean().optional(),
      notesSaved: z.boolean().optional(),
      cancelled: z.boolean().optional(),
    }),
  },
  {
    operationId: "contacts_record_prompt",
    endpoint: "contacts/record-prompt",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleContactRecordPrompt,
    summary: "Ask the guardian to confirm a contact record write",
    description:
      "Broadcasts a contact_record_request to connected clients and waits for the guardian to submit the form. The gateway owns the write and reports it back via resolve_contact_prompt. Nothing is written if nobody answers.",
    tags: ["contacts"],
    requestBody: ContactRecordPromptParams,
    responseBody: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      contactId: z.string().optional(),
      notesSaved: z.boolean().optional(),
      nothingWritten: z.boolean().optional(),
      merged: z.boolean().optional(),
      renamed: z.boolean().optional(),
      mirrored: z.boolean().optional(),
      cancelled: z.boolean().optional(),
    }),
  },
  {
    operationId: "resolve_contact_prompt",
    endpoint: "resolve_contact_prompt",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: resolveFormFromCallback,
    summary: "Gateway callback: resolve a pending contact prompt",
    description:
      "Called by the gateway after it writes the contact and channel. Unblocks the waiting contacts/prompt call.",
    tags: ["contacts"],
  },
  {
    operationId: "contact_prompt_claim",
    endpoint: "contact_prompt_claim",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: claimForm,
    summary: "Claim a pending contact form for one submission",
    description:
      "Marks a pending form as answered so a second client submitting the same form writes nothing. Returns claimed=false with reason 'already_claimed' when somebody got there first, or 'unknown' when no such form is pending. A granted claim carries the window its write has to report back in.",
    tags: ["contacts"],
    requestBody: ContactPromptFlagsParams,
    responseBody: z.object({
      claimed: z.boolean(),
      reason: z.enum(["already_claimed", "unknown"]).optional(),
      settleMs: z
        .number()
        .optional()
        .describe(
          "How long a granted claim has to report its write back before the waiting call gives up.",
        ),
    }),
  },
  {
    operationId: "contact_prompt_flags",
    endpoint: "contact_prompt_flags",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: readContactPromptFlags,
    summary: "Read a pending contact prompt's flags and binding target",
    description:
      "Returns whether a form is still parked under this id, whether the pending prompt asked the gateway to mark the submitted channel verified, and the contact the parked form targets, or the name and notes it proposes for a contact to create. known=false means no such form is pending, so nothing it may have targeted can be read.",
    tags: ["contacts"],
    requestBody: ContactPromptFlagsParams,
    responseBody: z.object({
      known: z
        .boolean()
        .describe(
          "Whether a form is still parked under this requestId. False leaves the target unreadable rather than absent.",
        ),
      verify: z.boolean(),
      contactId: z.string().optional(),
      displayName: z.string().optional(),
      notes: z.string().optional(),
    }),
  },
];
