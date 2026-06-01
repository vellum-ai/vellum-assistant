/**
 * `secret_request` SSE event.
 *
 * Server → client prompt asking the user to supply a credential value
 * (API key, password, etc.). Emitted by the credential prompter when
 * a tool call needs a missing secret and the daemon delegates
 * collection to the active client.
 *
 * Resolved by a paired `interaction_resolved` event (`kind: "secret"`,
 * `state: "answered" | "cancelled"`) once the client posts the secret
 * back via the credential-store route or cancels.
 *
 * `service`, `field`, and `label` are required because the prompter
 * always supplies them — they identify which credential the daemon is
 * asking for and how to label the input. Optional fields are scope
 * hints (`allowedTools`, `allowedDomains`), display affordances
 * (`description`, `placeholder`), and the `allowOneTimeSend` override
 * used by clients that support a "send without saving" path.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const SecretRequestEventSchema = z.object({
  type: z.literal("secret_request"),
  requestId: z.string(),
  service: z.string(),
  field: z.string(),
  label: z.string(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  conversationId: z.string().optional(),
  purpose: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  allowedDomains: z.array(z.string()).optional(),
  allowOneTimeSend: z.boolean().optional(),
});

export type SecretRequestEvent = z.infer<typeof SecretRequestEventSchema>;
