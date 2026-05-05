/**
 * IPC route for the `contacts/prompt` CLI command.
 *
 * Flow:
 *   1. CLI calls `contacts/prompt` IPC route with optional channel/role hints.
 *   2. Daemon broadcasts a `contact_request` to all connected clients.
 *   3. Client shows a contact address input form.
 *   4. User enters an address; client POSTs to the gateway's
 *      `POST /v1/contacts/prompt` HTTP route.
 *   5. Gateway upserts the contact + channel (gateway owns all contact writes).
 *   6. Gateway calls daemon IPC `resolve_contact_prompt` with the new contact info.
 *   7. Daemon resolves the pending promise; `contacts/prompt` IPC returns to CLI.
 *
 * The daemon only broadcasts the prompt and waits. It never writes contacts.
 * All writes go through the gateway.
 */

import { v4 as uuid } from "uuid";
import { z } from "zod";

import { getLogger } from "../../util/logger.js";
import { broadcastMessage } from "../assistant-event-hub.js";
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
}

interface PendingContactPrompt {
  resolve: (result: ContactPromptResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingContactPrompts = new Map<string, PendingContactPrompt>();

/**
 * Called by the gateway after it writes the contact and channel.
 * Resolves the pending promise so the CLI's `contacts/prompt` IPC call returns.
 */
function resolveContactPrompt({
  body = {},
}: RouteHandlerArgs): { resolved: boolean } {
  const { requestId, contactId, channelId, channelType, address, error } =
    body as {
      requestId: string;
      contactId?: string;
      channelId?: string;
      channelType?: string;
      address?: string;
      error?: string;
    };
  const pending = pendingContactPrompts.get(requestId);
  if (!pending) {
    log.warn({ requestId }, "resolve_contact_prompt: no pending prompt found");
    return { resolved: false };
  }

  clearTimeout(pending.timer);
  pendingContactPrompts.delete(requestId);

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
  label: z.string().optional().describe("Display label shown in the prompt UI."),
  description: z.string().optional().describe("Longer description for the prompt UI."),
  role: z
    .enum(["guardian", "trusted-contact", "unknown"])
    .default("unknown")
    .describe("Intended role of the contact being registered."),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleContactPrompt({
  body = {},
}: RouteHandlerArgs): Promise<ContactPromptResult> {
  const { channel, placeholder, label, description, role } =
    ContactPromptParams.parse(body);

  const requestId = uuid();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingContactPrompts.delete(requestId);
      log.warn({ requestId }, "Contact prompt timed out");
      resolve({ ok: false, error: "Prompt timed out" });
    }, CONTACT_PROMPT_TIMEOUT_MS);

    pendingContactPrompts.set(requestId, { resolve, timer });

    broadcastMessage({
      type: "contact_request",
      requestId,
      channel,
      placeholder,
      label,
      description,
      role,
    });

    log.info({ requestId, channel, role }, "Contact prompt broadcast");
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
    handler: handleContactPrompt,
    summary: "Prompt user to register a contact channel",
    description:
      "Broadcasts a contact_request to connected clients, waits for the user to submit an address via the gateway. The gateway owns the contact write and notifies the daemon via resolve_contact_prompt IPC.",
    tags: ["contacts"],
    requestBody: ContactPromptParams,
    responseBody: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      contactId: z.string().optional(),
      channelId: z.string().optional(),
      channelType: z.string().optional(),
      address: z.string().optional(),
    }),
  },
  {
    operationId: "resolve_contact_prompt",
    endpoint: "resolve_contact_prompt",
    method: "POST",
    handler: resolveContactPrompt,
    summary: "Gateway callback: resolve a pending contact prompt",
    description:
      "Called by the gateway after it writes the contact and channel. Unblocks the waiting contacts/prompt IPC call.",
    tags: ["contacts"],
  },
];
