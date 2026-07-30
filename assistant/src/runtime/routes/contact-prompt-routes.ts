/**
 * IPC route for the `contacts/prompt` CLI command.
 *
 * Address-entry flow:
 *   1. CLI calls `contacts/prompt` IPC route with optional channel/role hints.
 *   2. Daemon broadcasts a `contact_request` to all connected clients.
 *   3. Client shows a contact address input form.
 *   4. User enters an address; client POSTs to the gateway's
 *      `POST /v1/contacts/prompt` HTTP route.
 *   5. Gateway upserts the contact + channel (gateway owns all contact writes).
 *   6. Gateway calls daemon IPC `resolve_contact_prompt` with the new contact info.
 *   7. Daemon resolves the pending promise; `contacts/prompt` IPC returns to CLI.
 *
 * Merge-confirmation flow (`mergeKeepId` + `mergeDiscardId` both provided):
 *   1. CLI calls `contacts/prompt` IPC route with the two contact ids.
 *   2. Daemon looks up both contacts' names and broadcasts a `contact_request`
 *      with `mode: "merge"` instead of an address-entry hint set.
 *   3. Client shows a confirm/cancel UI (no address input).
 *   4. On confirm, client POSTs to the same gateway submit route with
 *      `{ requestId, mode: "merge" }` — the gateway does not write anything
 *      itself, it only relays the confirmation to daemon IPC
 *      `resolve_contact_prompt`.
 *   5. Daemon performs the merge itself (relaying to the gateway via the
 *      existing `merge_contacts` route/IPC, same as a CLI-initiated merge)
 *      and resolves the pending promise with the merge result.
 *
 * For address entry, the daemon only broadcasts the prompt and waits — it
 * never writes contacts, all writes go through the gateway. For a merge
 * confirmation, the daemon performs the write itself (via the same relay
 * `contacts/merge` already uses) once the guardian confirms.
 */

import { v4 as uuid } from "uuid";
import { z } from "zod";

import { getLogger } from "../../util/logger.js";
import { broadcastMessage } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  handleGetContact,
  handleMergeContactsRoute,
} from "./contact-routes.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("contact-prompt-routes");

/** Timeout for waiting on the user to submit the contact form (5 min). */
const CONTACT_PROMPT_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Pending contact prompts
// ---------------------------------------------------------------------------

export interface ContactPromptResult {
  ok: boolean;
  error?: string;
  contactId?: string;
  channelId?: string;
  channelType?: string;
  address?: string;
  /** Surviving contact after a merge confirmation. Merge mode only. */
  contact?: Record<string, unknown>;
}

interface PendingContactPrompt {
  resolve: (result: ContactPromptResult) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Set when this prompt is a merge confirmation rather than address entry. */
  merge?: { keepId: string; mergeId: string };
}

const pendingContactPrompts = new Map<string, PendingContactPrompt>();

/**
 * Called by the gateway once the guardian responds. For address-entry
 * prompts the gateway has already written the contact and channel and
 * passes their ids through. For merge-confirmation prompts the gateway
 * writes nothing — it only relays `confirmed`/`error`, and this handler
 * performs the merge itself by delegating to `handleMergeContactsRoute`
 * (the same relay a CLI-initiated `contacts/merge` call uses).
 *
 * Resolves the pending promise so the CLI's `contacts/prompt` IPC call returns.
 */
async function resolveContactPrompt({
  body = {},
}: RouteHandlerArgs): Promise<{ resolved: boolean }> {
  const {
    requestId,
    contactId,
    channelId,
    channelType,
    address,
    error,
    confirmed,
  } = body as {
    requestId: string;
    contactId?: string;
    channelId?: string;
    channelType?: string;
    address?: string;
    error?: string;
    confirmed?: boolean;
  };
  const pending = pendingContactPrompts.get(requestId);
  if (!pending) {
    log.warn({ requestId }, "resolve_contact_prompt: no pending prompt found");
    return { resolved: false };
  }

  clearTimeout(pending.timer);
  pendingContactPrompts.delete(requestId);

  if (pending.merge) {
    if (error) {
      pending.resolve({ ok: false, error });
    } else if (confirmed !== true) {
      // Treat anything other than an explicit confirmation (undefined from
      // a legacy client, false from a cancel, etc.) as a rejection. This
      // prevents an older client that doesn't understand merge mode from
      // accidentally approving a destructive merge via the address-entry
      // submit path.
      pending.resolve({ ok: false, error: "Merge cancelled by guardian" });
    } else {
      const { keepId, mergeId } = pending.merge;
      try {
        const result = (await handleMergeContactsRoute({
          body: { keepId, mergeId },
        })) as { ok: boolean; contact?: Record<string, unknown> };
        pending.resolve({
          ok: result.ok,
          contactId: (result.contact?.id as string | undefined) ?? keepId,
          contact: result.contact,
        });
      } catch (err) {
        log.error({ err, requestId, keepId, mergeId }, "Contact merge failed");
        pending.resolve({
          ok: false,
          error: err instanceof Error ? err.message : "Merge failed",
        });
      }
    }
    log.info({ requestId }, "Contact merge prompt resolved");
    return { resolved: true };
  }

  if (error) {
    pending.resolve({ ok: false, error });
  } else {
    pending.resolve({
      ok: true,
      contactId,
      channelId,
      channelType,
      address,
    });
  }

  log.info({ requestId, contactId }, "Contact prompt resolved");
  return { resolved: true };
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
  mergeKeepId: z
    .string()
    .optional()
    .describe(
      "UUID of the contact to keep. When provided together with mergeDiscardId, prompts the guardian to confirm a merge instead of an address entry.",
    ),
  mergeDiscardId: z
    .string()
    .optional()
    .describe(
      "UUID of the contact to merge away. Must be provided together with mergeKeepId.",
    ),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

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
    mergeKeepId,
    mergeDiscardId,
  } = ContactPromptParams.parse(body);

  if (Boolean(mergeKeepId) !== Boolean(mergeDiscardId)) {
    throw new BadRequestError(
      "mergeKeepId and mergeDiscardId must both be provided to prompt for a merge",
    );
  }
  if (mergeKeepId && mergeKeepId === mergeDiscardId) {
    throw new BadRequestError(
      "mergeKeepId and mergeDiscardId must refer to different contacts",
    );
  }

  const isMerge = Boolean(mergeKeepId && mergeDiscardId);

  let keepName: string | undefined;
  let discardName: string | undefined;
  if (isMerge) {
    const [keepResult, discardResult] = await Promise.all([
      handleGetContact(mergeKeepId!),
      handleGetContact(mergeDiscardId!),
    ]);
    keepName = keepResult?.contact.displayName;
    discardName = discardResult?.contact.displayName;
  }

  const requestId = uuid();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingContactPrompts.delete(requestId);
      log.warn({ requestId }, "Contact prompt timed out");
      resolve({ ok: false, error: "Prompt timed out" });
    }, CONTACT_PROMPT_TIMEOUT_MS);

    pendingContactPrompts.set(requestId, {
      resolve,
      timer,
      merge: isMerge
        ? { keepId: mergeKeepId!, mergeId: mergeDiscardId! }
        : undefined,
    });

    broadcastMessage({
      type: "contact_request",
      requestId,
      channel,
      placeholder,
      defaultValue,
      label,
      description,
      role,
      ...(isMerge && {
        mode: "merge" as const,
        keepId: mergeKeepId,
        discardId: mergeDiscardId,
        keepName,
        discardName,
      }),
    });

    log.info({ requestId, channel, role, isMerge }, "Contact prompt broadcast");
  });
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
    summary: "Prompt user to register a contact channel, or confirm a merge",
    description:
      "Broadcasts a contact_request to connected clients, waits for the user to submit an address via the gateway (address-entry mode) or confirm a merge (when mergeKeepId/mergeDiscardId are provided). In address-entry mode the gateway owns the contact write and notifies the daemon via resolve_contact_prompt IPC. In merge mode the daemon performs the merge itself once the guardian confirms.",
    tags: ["contacts"],
    requestBody: ContactPromptParams,
    responseBody: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      contactId: z.string().optional(),
      channelId: z.string().optional(),
      channelType: z.string().optional(),
      address: z.string().optional(),
      contact: z
        .object({})
        .passthrough()
        .optional()
        .describe("Surviving contact after a merge confirmation."),
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
    handler: resolveContactPrompt,
    summary: "Gateway callback: resolve a pending contact prompt",
    description:
      "Called by the gateway after it writes the contact and channel (address-entry mode), or after the guardian confirms/cancels a merge (merge mode, in which case the daemon performs the merge itself). Unblocks the waiting contacts/prompt IPC call.",
    tags: ["contacts"],
  },
];
